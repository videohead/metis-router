#!/usr/bin/env ts-node

import fs from 'fs/promises';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import * as readline from 'node:readline';
import { loadConfig, StandardMCPConfig, convertStandardMCPConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const GENERATED_DIR = path.join(__dirname, '../generated');
const INDEX_FILE = path.join(GENERATED_DIR, 'index.json');
const SEARCH_INDEX_FILE = path.join(GENERATED_DIR, 'search-index.json');

// Configuration
const DISCOVERY_TIMEOUT = 30000; // 30 seconds
const MAX_CONCURRENT_DISCOVERIES = 3;

// Types
interface MCPServerConnection {
  type: 'command' | 'sse' | 'http' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface MCPServerAuth {
  required: boolean;
  type?: 'oauth' | 'api_key';
  description?: string;
  envVar?: string;
}

interface MCPServerConfig {
  name: string;
  displayName: string;
  connection: MCPServerConnection;
  auth?: MCPServerAuth;
  category?: string;
  contributor?: string;
  description?: string;
  repositoryUrl?: string;
  license?: string;
  tags?: string[];
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface MCPResource {
  name: string;
  description?: string;
  uri?: string;
  mimeType?: string;
}

interface MCPCapabilities {
  description?: string;
  version?: string;
  mcpVersion?: string;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: any[];
  responseTime: number;
}

interface ConnectionTest {
  success: boolean;
  responseTime?: number;
  timestamp: string;
  error?: string;
}

interface DiscoveredServer extends MCPServerConfig {
  version: string;
  mcpVersion: string;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: any[];
  status: 'online' | 'offline' | 'unknown';
  lastIndexed: string;
  connectionTest: ConnectionTest;
  searchKeywords?: string;
}

interface ServerIndex {
  lastUpdated: string;
  totalServers: number;
  servers: DiscoveredServer[];
}

interface SearchIndexServer {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  tags?: string[];
  searchKeywords?: string;
  toolCount: number;
  toolNames: string[];
  status: 'online' | 'offline' | 'unknown';
}

interface SearchIndex {
  lastUpdated: string;
  servers: SearchIndexServer[];
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: object;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: object;
}

type PendingRequest = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

// JSON-RPC Client (adapted from utils.ts)
class JsonRpcClient {
  private proc: ChildProcess;
  private requestCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private rl: readline.Interface;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    if (!this.proc.stdout) {
      throw new Error('Process stdout is not available.');
    }

    this.rl = readline.createInterface({ input: this.proc.stdout });

    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          clearTimeout(pending.timeout);
          if (msg.error) {
            pending.reject(new Error(`RPC Error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
          this.pendingRequests.delete(msg.id);
        }
      } catch (e) {
        // Ignore non-JSON lines or other parsing errors
      }
    });

    this.proc.on('exit', (code) => {
      const err = new Error(`Process exited with code ${code}`);
      this.pendingRequests.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.reject(err);
      });
      this.pendingRequests.clear();
      this.rl.close();
    });
  }

  async request(method: string, params: object = {}): Promise<any> {
    const id = ++this.requestCounter;
    const requestMessage: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    if (!this.proc.stdin) {
      throw new Error('Process stdin is not available.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out for method: ${method}`));
      }, 30000); // 30-second timeout

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.proc.stdin!.write(JSON.stringify(requestMessage) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: object = {}): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    if (!this.proc.stdin) {
      throw new Error('Process stdin is not available.');
    }

    return new Promise((resolve, reject) => {
      this.proc.stdin!.write(JSON.stringify(notification) + '\n', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  destroy(): void {
    this.proc.kill();
    this.rl.close();
    this.pendingRequests.clear();
  }
}

/**
 * Convert internal config server to MCPServerConfig format
 */
function convertConfigServerToMCPConfig(serverConfig: any): MCPServerConfig {
  return {
    name: serverConfig.name,
    displayName: serverConfig.name, // Use name as display name for user configs
    connection: {
      type: serverConfig.transport.type || (serverConfig.transport.command ? 'command' : 'sse'),
      command: serverConfig.transport.command,
      args: serverConfig.transport.args,
      url: serverConfig.transport.url,
      env: typeof serverConfig.transport.env === 'object' && !Array.isArray(serverConfig.transport.env) 
        ? serverConfig.transport.env 
        : {},
      headers: serverConfig.transport.headers
    },
    category: 'user-defined',
    contributor: 'user',
    description: `User-configured ${serverConfig.name} MCP server`,
    tags: ['user-config']
  };
}

/**
 * Main indexing function
 */
async function indexServers(): Promise<void> {
  console.log('🚀 Starting MCP Server Discovery and Indexing...\n');
  
  try {
    // Ensure generated directory exists
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    
    // Load server configurations from mcp-registry.json
    const registryConfigs = await loadMCPRegistryConfigs();
    
    const allConfigs = registryConfigs;
    console.log(`📋 Found ${allConfigs.length} server configurations from mcp-registry.json`);
    
    // Discover server capabilities with limited concurrency
    const discoveredServers: DiscoveredServer[] = [];
    for (let i = 0; i < allConfigs.length; i += MAX_CONCURRENT_DISCOVERIES) {
      const batch = allConfigs.slice(i, i + MAX_CONCURRENT_DISCOVERIES);
      const batchPromises = batch.map(config => discoverServerCapabilities(config));
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          discoveredServers.push(result.value);
        }
      }
      
      console.log(`✅ Processed batch ${Math.floor(i / MAX_CONCURRENT_DISCOVERIES) + 1}/${Math.ceil(allConfigs.length / MAX_CONCURRENT_DISCOVERIES)}`);
    }
    
    console.log(`\n🔍 Successfully discovered ${discoveredServers.length}/${allConfigs.length} servers`);
    
    // Generate search keywords for each server
    const serversWithSearch = discoveredServers.map(generateSearchMetadata);
    
    // Create full index
    const fullIndex: ServerIndex = {
      lastUpdated: new Date().toISOString(),
      totalServers: serversWithSearch.length,
      servers: serversWithSearch
    };
    
    // Create search-optimized index
    const searchIndex: SearchIndex = {
      lastUpdated: new Date().toISOString(),
      servers: serversWithSearch.map(server => ({
        name: server.name,
        displayName: server.displayName,
        description: server.description,
        category: server.category,
        tags: server.tags,
        searchKeywords: server.searchKeywords,
        toolCount: server.tools ? server.tools.length : 0,
        toolNames: server.tools ? server.tools.map(t => t.name) : [],
        status: server.status
      }))
    };
    
    // Write indexes to files
    await fs.writeFile(INDEX_FILE, JSON.stringify(fullIndex, null, 2));
    await fs.writeFile(SEARCH_INDEX_FILE, JSON.stringify(searchIndex, null, 2));
    
    console.log(`\n📊 Indexing Summary:`);
    console.log(`   Total servers: ${fullIndex.totalServers}`);
    console.log(`   Online servers: ${discoveredServers.filter(s => s.status === 'online').length}`);
    console.log(`   Offline servers: ${discoveredServers.filter(s => s.status === 'offline').length}`);
    console.log(`   Total tools discovered: ${discoveredServers.reduce((sum, s) => sum + (s.tools?.length || 0), 0)}`);
    console.log(`\n📁 Generated files:`);
    console.log(`   📄 ${INDEX_FILE}`);
    console.log(`   🔍 ${SEARCH_INDEX_FILE}`);
    
    console.log('\n✅ Indexing completed successfully!');
    
  } catch (error) {
    console.error('❌ Indexing failed:', error);
    process.exit(1);
  }
}



/**
 * Load MCP server configurations from mcp-registry.json
 */
async function loadMCPRegistryConfigs(): Promise<MCPServerConfig[]> {
  try {
    const registryPath = path.join(__dirname, '../mcp-registry.json');
    const registryContent = await fs.readFile(registryPath, 'utf-8');
    const registry = JSON.parse(registryContent);
    
    if (!registry.mcpServers || Object.keys(registry.mcpServers).length === 0) {
      return [];
    }

    // Convert mcp-registry format to MCPServerConfig format
    const configs: MCPServerConfig[] = [];
    for (const [name, serverConfig] of Object.entries(registry.mcpServers)) {
      const config = serverConfig as any;

      if (config.url) {
        // URL-based servers (streamable-http / sse)
        configs.push({
          name,
          displayName: name,
          connection: {
            type: 'streamable-http',
            url: config.url,
            env: config.env || {},
            headers: config.headers
          },
          description: config.description || `${name} MCP server`,
          category: 'registry'
        });
      } else {
        configs.push({
          name,
          displayName: name,
          connection: {
            type: 'command',
            command: config.command,
            args: config.args || [],
            env: config.env || {}
          },
          description: `${name} MCP server`,
          category: 'registry'
        });
      }
    }

    return configs;
  } catch (error: any) {
    console.warn(`⚠️  Failed to load MCP registry configs: ${error.message}`);
    return [];
  }
}

/**
 * Discover server capabilities through proper MCP introspection (adapted from utils.ts)
 */
async function discoverServerCapabilities(config: MCPServerConfig): Promise<DiscoveredServer> {
  console.log(`🔎 Discovering capabilities for ${config.displayName}...`);
  
  try {
    const capabilities = await connectAndIntrospect(config);
    
    const discoveredServer: DiscoveredServer = {
      ...config,
      description: capabilities.description || config.description || `${config.displayName} MCP server`,
      version: capabilities.version || 'unknown',
      mcpVersion: capabilities.mcpVersion || 'unknown',
      tools: capabilities.tools || [],
      resources: capabilities.resources || [],
      prompts: capabilities.prompts || [],
      status: 'online',
      lastIndexed: new Date().toISOString(),
      connectionTest: {
        success: true,
        responseTime: capabilities.responseTime,
        timestamp: new Date().toISOString()
      }
    };
    
    console.log(`   ✅ ${config.displayName}: ${discoveredServer.tools.length} tools, ${discoveredServer.resources.length} resources`);
    return discoveredServer;
    
  } catch (error: any) {
    console.log(`   ❌ ${config.displayName}: ${error.message}`);
    
    // Return server config with offline status
    return {
      ...config,
      description: config.description || `${config.displayName} MCP server`,
      version: 'unknown',
      mcpVersion: 'unknown',
      tools: [],
      resources: [],
      prompts: [],
      status: 'offline',
      lastIndexed: new Date().toISOString(),
      connectionTest: {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  }
}

/**
 * Connect to MCP server and perform proper introspection (adapted from utils.ts)
 */
async function connectAndIntrospect(config: MCPServerConfig): Promise<MCPCapabilities> {
  const startTime = Date.now();
  
  // Handle URL-based servers differently (we can't introspect these easily)
  if (config.connection.type === 'sse' || config.connection.type === 'streamable-http') {
    // For URL-based servers, we return basic info since we can't easily connect
    return {
      description: config.displayName,
      version: 'unknown',
      mcpVersion: 'unknown',
      tools: [], // Could potentially make HTTP requests to discover tools
      resources: [],
      prompts: [],
      responseTime: Date.now() - startTime
    };
  }

  if (config.connection.type !== 'command') {
    throw new Error(`Connection type "${config.connection.type}" not supported for introspection`);
  }

  if (!config.connection.command) {
    throw new Error('No command specified for server');
  }

  const rpcClient = new JsonRpcClient(
    config.connection.command,
    config.connection.args || [],
    config.connection.env || {}
  );

  try {
    // 1. MCP Handshake
    console.log(`   - Performing MCP handshake for ${config.displayName}...`);
    const initializeResult = await rpcClient.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: {
        name: 'metis-indexer',
        version: '1.0.0',
      },
      capabilities: {
        roots: {
          listChanged: true
        },
        sampling: {}
      },
    });
    
    console.log(`   - Handshake successful for ${config.displayName}`);
    
    // Send initialized notification
    await rpcClient.notify('notifications/initialized', {});
    console.log(`   - Sent 'initialized' notification for ${config.displayName}`);

    // 2. Get tools
    const listResult = await rpcClient.request('tools/list', {});
    const tools = listResult.tools || [];
    console.log(`   - Found ${tools.length} tools for ${config.displayName}`);

    // 3. Get resources (optional)
    let resources: MCPResource[] = [];
    try {
      const resourcesResult = await rpcClient.request('resources/list', {});
      resources = resourcesResult.resources || [];
      console.log(`   - Found ${resources.length} resources for ${config.displayName}`);
    } catch (e) {
      // Resources are optional, continue if not supported
      console.log(`   - Resources not supported for ${config.displayName}`);
    }

    // 4. Get prompts (optional)
    let prompts: any[] = [];
    try {
      const promptsResult = await rpcClient.request('prompts/list', {});
      prompts = promptsResult.prompts || [];
      console.log(`   - Found ${prompts.length} prompts for ${config.displayName}`);
    } catch (e) {
      // Prompts are optional, continue if not supported
      console.log(`   - Prompts not supported for ${config.displayName}`);
    }

    const capabilities: MCPCapabilities = {
      description: initializeResult.serverInfo?.name || config.displayName,
      version: initializeResult.serverInfo?.version || 'unknown',
      mcpVersion: initializeResult.protocolVersion || 'unknown',
      tools,
      resources,
      prompts,
      responseTime: Date.now() - startTime
    };

    return capabilities;

  } finally {
    rpcClient.destroy();
  }
}

/**
 * Generate search metadata for a server
 */
function generateSearchMetadata(server: DiscoveredServer): DiscoveredServer {
  const searchKeywords = [
    server.name,
    server.displayName,
    server.description,
    ...(server.tags || []),
    ...(server.tools || []).map(t => t.name),
    ...(server.tools || []).map(t => t.description),
    server.category
  ].filter(Boolean).join(' ').toLowerCase();
  
  return {
    ...server,
    searchKeywords
  };
}

async function main(): Promise<void> {
  console.log('Starting MCP server indexing process...');
  
  try {
    await indexServers();
    console.log('\nIndexing process finished.');
    process.exit(0);
  } catch (err: any) {
    console.error('A critical error occurred:', err);
    process.exit(1);
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { indexServers, loadMCPRegistryConfigs, discoverServerCapabilities }; 