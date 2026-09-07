import fs from 'fs';
import path from 'path';

// Standard MCP config format (like Claude Desktop uses)
export interface StandardMCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  basicAuth?: {
    username: string;
    password: string;
  };
}

export interface StandardMCPConfig {
  mcpServers: Record<string, StandardMCPServerConfig>;
}

// Our internal config format
export interface ServerConfig {
  name: string;
  transport: {
    type?: 'command' | 'sse' | 'streamable-http';
    command?: string;
    args?: string[];
    env?: Record<string, string> | string[];
    url?: string;
    headers?: Record<string, string>;
    basicAuth?: {
      username: string;
      password: string;
    };
  };
}

export interface Config {
  servers: ServerConfig[];
  active_mcp_queue?: string[];
}

const DEFAULT_CONFIG_PATH = './config.json';

function resolveEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => {
      const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
      return [name, match ? process.env[match[1]] || '' : value];
    })
  );
}

function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
      return [name, match ? process.env[match[1]] || '' : value];
    })
  );
}

function resolveValue(value: string): string {
  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  return match ? process.env[match[1]] || '' : value;
}

/**
 * Convert standard MCP config format to our internal format
 */
export function convertStandardMCPConfig(standardConfig: StandardMCPConfig): Config {
  const servers: ServerConfig[] = [];
  
  for (const [serverName, serverConfig] of Object.entries(standardConfig.mcpServers)) {
    const internalConfig: ServerConfig = {
      name: serverName,
      transport: {}
    };

    if (serverConfig.command) {
      // Command-based server
      internalConfig.transport.type = 'command';
      internalConfig.transport.command = serverConfig.command;
      internalConfig.transport.args = serverConfig.args || [];
      if (serverConfig.env) {
        internalConfig.transport.env = resolveEnvironmentVariables(serverConfig.env);
      }
    } else if (serverConfig.url) {
      // URL-based server - determine type based on URL or default to SSE
      if (serverConfig.url.includes('/sse') || serverConfig.url.endsWith('/sse')) {
        internalConfig.transport.type = 'sse';
      } else {
        internalConfig.transport.type = 'streamable-http';
      }
      internalConfig.transport.url = serverConfig.url;
      if (serverConfig.headers) {
        internalConfig.transport.headers = resolveHeaders(serverConfig.headers);
      }
      if (serverConfig.basicAuth) {
        internalConfig.transport.basicAuth = {
          username: resolveValue(serverConfig.basicAuth.username),
          password: resolveValue(serverConfig.basicAuth.password)
        };
      }
    }

    servers.push(internalConfig);
  }

  return {
    servers,
    active_mcp_queue: []
  };
}

/**
 * Load configuration from file, supporting both standard MCP format and our internal format
 */
export function loadConfig(configPath?: string): Config {
  const filePath = configPath || process.env.MCP_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  
  if (!fs.existsSync(filePath)) {
    console.warn(`Config file not found: ${filePath}. Using empty config.`);
    return { servers: [], active_mcp_queue: [] };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Check if it's standard MCP format
    if (parsed.mcpServers) {
      console.log('📝 Loading standard MCP configuration format...');
      return convertStandardMCPConfig(parsed as StandardMCPConfig);
    }
    
    // Otherwise assume it's our internal format
    console.log('📝 Loading internal configuration format...');
    const config = parsed as Config;
    config.servers = config.servers.map(server => ({
      ...server,
      transport: {
        ...server.transport,
        headers: server.transport.headers ? resolveHeaders(server.transport.headers) : undefined
      }
    }));
    return config;
  } catch (error) {
    console.error(`Failed to load config from ${filePath}:`, error);
    return { servers: [], active_mcp_queue: [] };
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: Config, configPath?: string): void {
  const filePath = configPath || process.env.MCP_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  
  try {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`Failed to save config to ${filePath}:`, error);
    throw error;
  }
}

/**
 * Create a sample standard MCP config for users
 */
export function createSampleStandardConfig(): StandardMCPConfig {
  return {
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: {
          NODE_ENV: "development"
        }
      },
      postgres: {
        command: "uvx",
        args: ["mcp-server-postgres", "postgresql://user:password@localhost/mydb"]
      },
      linear: {
        command: "npx",
        args: ["-y", "mcp-remote", "linear"],
        env: {
          LINEAR_API_KEY: "your-api-key"
        }
      },
      brave_search: {
        command: "npx",
        args: ["-y", "mcp-remote", "brave-search"],
        headers: {
          "X-API-Key": "your-api-key"
        }
      }
    }
  };
}

export default { loadConfig, convertStandardMCPConfig, createSampleStandardConfig, saveConfig };



