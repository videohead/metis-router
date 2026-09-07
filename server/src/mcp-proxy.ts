import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  Tool,
  ListToolsResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ResourceTemplate,
  CompatibilityCallToolResultSchema,
  GetPromptResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createClients, ConnectedClient, ConnectionHooks } from './client.js';
import { Config, loadConfig, ServerConfig } from './config.js';
import { z } from 'zod';
import EventSource from 'eventsource';
import { addNewMcp, AddMCPResult, heatUpMcpServer } from './add-new-mcp.js';
import { searchMCPs } from './search-mcps.js';
import chokidar from 'chokidar';
import path from 'path';

// Extend global interface for notification function
declare global {
  var notifyAllSessions: ((notification: any) => void) | undefined;
  var notifySpecificSession: ((sessionId: string, notification: any) => void) | undefined;
}

function mcpLog(message: string) {
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    method: "log",
    params: { message }
  }));
}

global.EventSource = EventSource as any

export const createServer = async () => {
  // Function to notify sessions that tools have changed
  function notifyToolListChanged() {
    if (global.notifyAllSessions) {
      global.notifyAllSessions({
        method: 'notifications/tools/list_changed',
        params: {}
      });
    }
  }

  const toolToClientMap = new Map<string, ConnectedClient>();
  const resourceToClientMap = new Map<string, ConnectedClient>();
  const promptToClientMap = new Map<string, ConnectedClient>();

  // Deterministic routing: every routed name is namespaced as "server:name".
  // Strip any existing "[server] " prefix so double-listing doesn't compound it.
  const stripPrefix = (desc: string | undefined) => (desc || '').replace(/^\[[^\]]+\]\s*/, '');
  const ns = (server: string, name: string) => `${server}:${name}`;
  // Register a name so both the canonical prefixed form and the bare original
  // resolve, but never let a bare name steal an already-claimed route.
  const registerRoute = (map: Map<string, ConnectedClient>, server: string, name: string, client: ConnectedClient) => {
    map.set(ns(server, name), client);
    if (!map.has(name)) map.set(name, client);
  };

  // Swap a reconnected client into the active set and invalidate cached routes.
  const handleReconnect = async (name: string, fresh: ConnectedClient) => {
    const idx = connectedClients.findIndex(c => c.name === name);
    const stale = idx >= 0 ? connectedClients[idx] : undefined;
    if (idx >= 0) connectedClients[idx] = fresh; else connectedClients.push(fresh);
    if (stale) { try { await stale.cleanup(); } catch { } }
    toolToClientMap.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();
    mcpLog(`Rebuilt routing after reconnect of ${name}`);
    notifyToolListChanged();
  };

  // Build a fresh client+transport for a single server (used by reconnect paths).
  const connectOne = async (server: ServerConfig, hooks: ConnectionHooks): Promise<ConnectedClient> => {
    const [fresh] = await createClients([server], hooks);
    if (!fresh) throw new Error(`connect failed for ${server.name}`);
    return fresh;
  };

  // Reconnect one upstream by name (e.g. after its MCP session expired on restart).
  // Retries briefly to ride out the upstream's own restart window. Guarded so
  // concurrent triggers (probe + onclose + call-path) don't stack reconnects.
  const reconnectingServers = new Set<string>();
  const reconnectServer = async (name: string, attempts = 5): Promise<boolean> => {
    if (reconnectingServers.has(name)) return false;
    reconnectingServers.add(name);
    try {
      const serverConfig = config.servers.find((s: any) => s.name === name);
      if (!serverConfig) return false;
      for (let i = 1; i <= attempts; i++) {
        try {
          const fresh = await connectOne(serverConfig, { onReconnect: handleReconnect });
          await handleReconnect(name, fresh);
          mcpLog(`Reconnected to ${name} on demand (attempt ${i})`);
          return true;
        } catch (err) {
          console.error(`On-demand reconnect to ${name} attempt ${i}/${attempts} failed:`, err);
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (i - 1), 8000)));
        }
      }
      return false;
    } finally {
      reconnectingServers.delete(name);
    }
  };

  // True when an error indicates the upstream session/connection is dead and a
  // reconnect (not just a retry) is required.
  const isConnectionError = (error: any) =>
    error?.code === -32000 ||
    /session not found|connection closed|terminated|fetch failed/i.test(String(error?.message ?? ''));

  // Load configuration and connect to servers
  let config = loadConfig();

  let connectedClients = await createClients(config.servers, { onReconnect: handleReconnect });
  mcpLog(`Connected to ${connectedClients.length} servers`);

  // Periodic health probe: for HTTP/SSE upstreams, a dead MCP session (e.g. the
  // upstream restarted) never fires transport.onclose — it only surfaces as a
  // 404 on the next request. Probe each HTTP/SSE upstream with a lightweight
  // ping and reconnect any whose session has died, so tools self-heal.
  const HEALTH_INTERVAL_MS = 15000;
  const healthProbe = setInterval(async () => {
    for (const cc of connectedClients) {
      if (reconnectingServers.has(cc.name)) continue; // already being reconnected
      const serverCfg = config.servers.find((s: any) => s.name === cc.name);
      const t = serverCfg?.transport?.type;
      if (t !== 'streamable-http' && t !== 'sse') continue; // stdio has its own lifecycle
      try {
        await cc.client.request({ method: 'ping', params: {} }, z.object({}).passthrough());
      } catch (err: any) {
        // ping unsupported is fine (server alive); only reconnect on a dead session/connection
        if (isConnectionError(err)) {
          console.warn(`Health probe: ${cc.name} session dead (${err?.message}), reconnecting...`);
          await reconnectServer(cc.name);
        }
      }
    }
  }, HEALTH_INTERVAL_MS);
  healthProbe.unref?.();

  // Function to reload MCP server connections
  async function reloadServerConnections() {
    console.log("Reloading MCP server connections...");
    
    // Clean up existing connections
    await Promise.all(connectedClients.map(({ cleanup }) => cleanup()));

    // Reload config and create new connections
    config = loadConfig();
    connectedClients = await createClients(config.servers, { onReconnect: handleReconnect });
    
    // Clear the maps since the clients have changed
    toolToClientMap.clear();
    resourceToClientMap.clear();
    promptToClientMap.clear();
    
    mcpLog(`Reconnected to ${connectedClients.length} servers`);
    
    // Notify all sessions that the tool list has changed
    notifyToolListChanged();
  }

  const configPath = path.resolve('./config.json');
  const watcher = chokidar.watch(configPath).on('change', async (path) => { 
    console.log('config.json changed, reloading server connections and notifying client.');
    
    try {
      // Only reload if this is a legitimate config change, not from heating
      const newConfig = loadConfig();
      const hasServerChanges = JSON.stringify(config.servers) !== JSON.stringify(newConfig.servers);
      
      if (hasServerChanges) {
        console.log("Detected server configuration changes, reloading connections...");
        await reloadServerConnections();
      } else {
        console.log("Config change detected but no server changes, skipping connection reload");
        config = newConfig; // Just update the config without reloading connections
      }
    } catch (error) {
      console.error('Error reloading server connections:', error);
    }
  });

  // Maps (declared above) track which client owns which tool/prompt/resource.
  const server = new Server(
    {
      name: "metis",
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: { subscribe: true },
        tools: {},
      },
    },
  );

  // List Tools Handler
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const allTools: Tool[] = [];
    toolToClientMap.clear();

    for (const connectedClient of connectedClients) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'tools/list',
            params: {
              _meta: request.params?._meta
            }
          },
          ListToolsResultSchema
        );

        if (result.tools) {
          const toolsWithSource = result.tools.map((tool: Tool) => {
            registerRoute(toolToClientMap, connectedClient.name, tool.name, connectedClient);
            return {
              ...tool,
              name: ns(connectedClient.name, tool.name),
              description: `[${connectedClient.name}] ${stripPrefix(tool.description)}`
            };
          });
          allTools.push(...toolsWithSource);
        }
      } catch (error) {
        console.error(`Error fetching tools from ${connectedClient.name}:`, error);
        // Self-heal: a dead session/connection shouldn't permanently drop this
        // server's tools from the gateway. Reconnect and retry once inline.
        if (isConnectionError(error)) {
          const healed = await reconnectServer(connectedClient.name, 2);
          if (healed) {
            const fresh = connectedClients.find(c => c.name === connectedClient.name);
            if (fresh) {
              try {
                const retry = await fresh.client.request({ method: 'tools/list', params: { _meta: request.params?._meta } }, ListToolsResultSchema);
                if (retry.tools) {
                  for (const tool of retry.tools) {
                    registerRoute(toolToClientMap, fresh.name, tool.name, fresh);
                    allTools.push({ ...tool, name: ns(fresh.name, tool.name), description: `[${fresh.name}] ${stripPrefix(tool.description)}` });
                  }
                }
              } catch (e) {
                console.error(`Retry tools/list failed for ${fresh.name}:`, e);
              }
            }
          }
        }
      }
    }

    // Add the single MCP management tool
    mcpLog("Adding add_new_mcp tool");
    allTools.push({
      name: 'add_new_mcp',
      description: 'Add a new MCP server by name from the modelcontextprotocol/servers repository.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the MCP server to add (e.g., "github", "google-maps", "postgresql")'
          },
          arguments: {
            type: 'object',
            description: 'Optional arguments required by the MCP server (e.g., file paths, connection strings)',
            additionalProperties: {
              type: 'string'
            }
          }
        },
        required: ['name']
      }
    });

    // Add the semantic search tool
    mcpLog("Adding search_mcps tool");
    allTools.push({
      name: 'search_mcps',
      description: 'Search for MCP servers using semantic similarity based on your query. Returns the most relevant servers with their tools.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Your search query describing the functionality you need (e.g., "file operations", "database access", "text-to-speech")'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 3, max: 10)',
            minimum: 1,
            maximum: 10
          }
        },
        required: ['query']
      }
    });

    return { tools: allTools };
  });

  // Call Tool Handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    console.log(`CallTool request: ${name}, available tools: ${Array.from(toolToClientMap.keys()).join(', ')}`);
    
    // Handle the add_new_mcp tool
    if (name === 'add_new_mcp') {
      const serverName = typeof args?.name === 'string' ? args.name : undefined;
      if (!serverName) {
        throw new Error("Missing or invalid 'name' argument for add_new_mcp tool");
      }
      
      const serverArgs = args?.arguments && typeof args.arguments === 'object' ? 
        args.arguments as Record<string, string> : undefined;
      
      const result: AddMCPResult = await addNewMcp(serverName, serverArgs);
      
      let responseText = result.message;
      
      if (result.authRequest) {
        responseText += "\n\n" + result.authRequest.message;
      }
      
      if (result.argumentsRequest) {
        responseText += "\n\n" + result.argumentsRequest.message;
      }
      
      if (result.serverInfo) {
        responseText += `\n\nServer: ${result.serverInfo.name} (${result.serverInfo.language})`;
        responseText += `\nPackage: ${result.serverInfo.packageName}`;
      }

      // If server was successfully added, wait for connections to reload and refresh our tool maps
      if (result.success) {
        try {
          console.log("Server added successfully. Reloading connections directly...");
          
          // Don't wait for file watcher - reload connections directly
          await reloadServerConnections();
          
          console.log(`After reload, connected clients: ${connectedClients.map(c => c.name).join(', ')}`);
          
          // Now rebuild tool mappings since reloadServerConnections() clears them
          console.log("Rebuilding tool mappings after direct reload...");
          
          for (const connectedClient of connectedClients) {
            try {
              const toolsResult = await connectedClient.client.request(
                {
                  method: 'tools/list',
                  params: {}
                },
                ListToolsResultSchema
              );
              
              if (toolsResult.tools) {
                toolsResult.tools.forEach((tool: Tool) => {
                  registerRoute(toolToClientMap, connectedClient.name, tool.name, connectedClient);
                });
                console.log(`Added ${toolsResult.tools.length} tools from ${connectedClient.name}: ${toolsResult.tools.map(t => t.name).join(', ')}`);
              }
            } catch (error) {
              console.warn(`Failed to refresh tools for ${connectedClient.name}:`, error);
            }
          }
          
          const newToolCount = toolToClientMap.size;
          console.log(`Tool maps rebuilt. Now tracking ${newToolCount} tools: ${Array.from(toolToClientMap.keys()).join(', ')}`);
          
          if (newToolCount > 0) {
            responseText += `\n\n✅ Server connected and ${newToolCount} tools are now available for immediate use.`;
            responseText += `\n\nAvailable tools: ${Array.from(toolToClientMap.keys()).join(', ')}`;
          } else {
            responseText += "\n\n⚠️ Server added but no tools detected yet. Tools may be available on next request.";
          }
          
        } catch (error) {
          console.error("Error during post-add tool refresh:", error);
          responseText += "\n\n⚠️ Server added but tool refresh failed. Tools may be available on next request.";
        }
      }

      return {
        content: [
          {
            type: "text",
            text: responseText
          }
        ]
      };
    }

    // Handle the search_mcps tool
    if (name === 'search_mcps') {
      const query = typeof args?.query === 'string' ? args.query : undefined;
      if (!query) {
        throw new Error("Missing or invalid 'query' argument for search_mcps tool");
      }
      
      const limit = typeof args?.limit === 'number' ? Math.min(Math.max(args.limit, 1), 10) : 4;
      
      try {
        const results = await searchMCPs(query, limit);
        
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "❌ No MCP servers found. Ensure embeddings have been generated and the database is accessible."
              }
            ]
          };
        }

        // Create structured, concise response
        let responseText = `🔍 **Top ${results.length} MCP Servers for "${query}"**\n\n`;
        
        results.forEach((result, index) => {
          const similarity = (result.similarity * 100).toFixed(0);
          responseText += `**${index + 1}. ${result.displayName}** (${similarity}% match)\n`;
          responseText += `   📝 ${result.description}\n`;
          
          if (result.tools && result.tools.length > 0) {
            const toolNames = result.tools.map((tool: any) => tool.name);
            if (toolNames.length <= 6) {
              responseText += `   🛠️  Tools: ${toolNames.join(', ')}\n`;
            } else {
              responseText += `   🛠️  Tools: ${toolNames.slice(0, 6).join(', ')}, +${toolNames.length - 6} more\n`;
            }
          } else {
            responseText += `   🛠️  Tools: None indexed\n`;
          }
          responseText += `\n`;
        });
        
        responseText += `💡 Use \`add_new_mcp\` tool to install any server that matches your needs.`;
        
        return {
          content: [
            {
              type: "text",
              text: responseText
            }
          ]
        };
      } catch (error: any) {
        const errorMessage = `❌ Search failed: ${error.message}\n\n`;
        let troubleshooting = "**Troubleshooting:**\n";
        
        if (error.message.includes('OpenAI API key')) {
          troubleshooting += "• Set your OpenAI API key in the environment variables\n";
        } else if (error.message.includes('database') || error.message.includes('connection')) {
          troubleshooting += "• Check that the database is running and accessible\n";
          troubleshooting += "• Verify database connection settings\n";
        } else {
          troubleshooting += "• Check the server logs for more details\n";
          troubleshooting += "• Ensure embeddings have been generated for MCP servers\n";
        }
        
        return {
          content: [
            {
              type: "text",
              text: errorMessage + troubleshooting
            }
          ]
        };
      }
    }

    // Resolve "server:tool" (canonical) or a bare name; forward the bare tool name upstream.
    const clientForTool = toolToClientMap.get(name);
    const upstreamToolName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

    if (!clientForTool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // >>> BEGINNING OF HEATING LOGIC >>> 
    try {
      heatUpMcpServer(clientForTool.name); // Call heatUpMcpServer without sessionId
    } catch (heatError) {
      // Log the heating error but don't let it stop the tool call
      console.error(`Error heating up server ${clientForTool.name}:`, heatError);
      mcpLog(`Error heating up server ${clientForTool.name}: ${heatError instanceof Error ? heatError.message : 'Unknown error'}`);
    }
    // <<< END OF HEATING LOGIC >>>

    // Retry logic for tool calls. On a dead session/connection, reconnect the
    // upstream first, then re-resolve the (possibly new) client before retrying.
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const currentClient = toolToClientMap.get(name) ?? clientForTool;
      try {
        // Use the correct schema for tool calls
        return await currentClient.client.request(
          {
            method: 'tools/call',
            params: {
              name: upstreamToolName,
              arguments: args || {},
              _meta: {
                progressToken: request.params._meta?.progressToken
              }
            }
          },
          CompatibilityCallToolResultSchema
        );
      } catch (error: any) {
        lastError = error;

        if (isConnectionError(error) && attempt < maxRetries) {
          console.log(`Connection/session error for ${clientForTool.name}, reconnecting (attempt ${attempt + 1}/${maxRetries + 1})...`);
          await reconnectServer(clientForTool.name);
          continue; // loop re-resolves toolToClientMap to the fresh client
        }

        // Not a connection error or retries exhausted: surface it.
        console.error(`Error calling tool through ${clientForTool.name}:`, error);
        throw error;
      }
    }

    // This should never be reached, but just in case
    throw lastError;
  });

  // Get Prompt Handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClientMap.get(name);
    const upstreamPromptName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      // console.log('Forwarding prompt request:', name);

      // Match the exact structure from the example code
      const response = await clientForPrompt.client.request(
        {
          method: 'prompts/get' as const,
          params: {
            name: upstreamPromptName,
            arguments: request.params.arguments || {},
            _meta: request.params._meta || {
              progressToken: undefined
            }
          }
        },
        GetPromptResultSchema
      );

      mcpLog(`Prompt result: ${response}`);
      return response;
    } catch (error) {
      // Only log if it's not a "Method not found" error (expected for servers without prompt support)
      if (error instanceof Error && !error.message.includes('Method not found')) {
        console.error(`Error getting prompt from ${clientForPrompt.name}:`, error);
      } else {
        // Just log debug info for method not found errors
        mcpLog(`Server ${clientForPrompt.name} does not support prompts (method not found)`);
      }
      throw error;
    }
  });

  // List Prompts Handler
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const allPrompts: z.infer<typeof ListPromptsResultSchema>['prompts'] = [];
    promptToClientMap.clear();

    for (const connectedClient of connectedClients) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'prompts/list' as const,
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta || {
                progressToken: undefined
              }
            }
          },
          ListPromptsResultSchema
        );

        if (result.prompts) {
          const promptsWithSource = result.prompts.map((prompt: any) => {
            registerRoute(promptToClientMap, connectedClient.name, prompt.name, connectedClient);
            return {
              ...prompt,
              name: ns(connectedClient.name, prompt.name),
              description: `[${connectedClient.name}] ${stripPrefix(prompt.description)}`
            };
          });
          allPrompts.push(...promptsWithSource);
        }
      } catch (error: any) {
        // Skip servers that don't support prompts (error code -32601)
        if (error?.code === -32601) {
          continue;
        }
        console.error(`Error fetching prompts from ${connectedClient.name}:`, error);
      }
    }

    return {
      prompts: allPrompts,
      nextCursor: request.params?.cursor
    };
  });

  // List Resources Handler
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const allResources: z.infer<typeof ListResourcesResultSchema>['resources'] = [];
    resourceToClientMap.clear();

    for (const connectedClient of connectedClients) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'resources/list',
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta
            }
          },
          ListResourcesResultSchema
        );

        if (result.resources) {
          const resourcesWithSource = result.resources.map((resource: any) => {
            registerRoute(resourceToClientMap, connectedClient.name, resource.uri, connectedClient);
            return {
              ...resource,
              uri: ns(connectedClient.name, resource.uri),
              name: `[${connectedClient.name}] ${resource.name || ''}`
            };
          });
          allResources.push(...resourcesWithSource);
        }
      } catch (error) {
        console.error(`Error fetching resources from ${connectedClient.name}:`, error);
      }
    }

    return {
      resources: allResources,
      nextCursor: undefined
    };
  });

  // Read Resource Handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const clientForResource = resourceToClientMap.get(uri);
    const upstreamUri = uri.includes(':') ? uri.slice(uri.indexOf(':') + 1) : uri;

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: 'resources/read',
          params: {
            uri: upstreamUri,
            _meta: request.params._meta
          }
        },
        ReadResourceResultSchema
      );
    } catch (error) {
      console.error(`Error reading resource from ${clientForResource.name}:`, error);
      throw error;
    }
  });

  // List Resource Templates Handler
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const allTemplates: ResourceTemplate[] = [];

    for (const connectedClient of connectedClients) {
      try {
        const result = await connectedClient.client.request(
          {
            method: 'resources/templates/list' as const,
            params: {
              cursor: request.params?.cursor,
              _meta: request.params?._meta || {
                progressToken: undefined
              }
            }
          },
          ListResourceTemplatesResultSchema
        );

        if (result.resourceTemplates) {
          const templatesWithSource = result.resourceTemplates.map((template: ResourceTemplate) => ({
            ...template,
            name: `[${connectedClient.name}] ${template.name || ''}`,
            description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
          }));
          allTemplates.push(...templatesWithSource);
        }
      } catch (error) {
        console.error(`Error fetching resource templates from ${connectedClient.name}:`, error);
      }
    }

    return {
      resourceTemplates: allTemplates,
      nextCursor: request.params?.cursor
    };
  });

  const cleanup = async () => {
    console.log("Cleaning up resources...");
    await watcher.close();
    await Promise.all(connectedClients.map(({ cleanup }) => cleanup()));
  };

  // Handle process termination
  process.on('SIGINT', async () => {
    console.log('Received SIGINT. Cleaning up...');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Cleaning up...');
    await cleanup();
    process.exit(0);
  });

  return { server, cleanup };
};

