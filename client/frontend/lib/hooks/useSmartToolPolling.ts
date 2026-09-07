"use client";

import { useState, useEffect, useCallback } from 'react';
import { Tool } from '../services/api';
import apiService from '../services/api';

export const useSmartToolPolling = (sessionId?: string) => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshTools = useCallback(async (showLoading = false) => {
    if (!sessionId) {
      setTools([]);
      setIsLoading(false);
      return;
    }

    try {
      if (showLoading) setIsLoading(true);
      setError(null);
      
      const response = await apiService.listSessionTools(sessionId);
      
      // The backend resolves the originating MCP server per tool, since a single
      // session connects to the router which aggregates many upstream servers.
      const formattedTools = response.tools.map(tool => ({
        name: tool.name,
        full_name: tool.full_name || tool.name,
        description: tool.description || 'No description available',
        server: tool.server || 'metis'
      }));
      
      setTools(formattedTools);
      setIsLoading(false);
      setError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch tools';
      setError(errorMsg);
      console.error('Failed to refresh tools:', err);
      setIsLoading(false);
    }
  }, [sessionId]);

  // Refresh tools when sessionId changes
  useEffect(() => {
    if (sessionId) {
      refreshTools(true);
    } else {
      setTools([]);
      setIsLoading(false);
    }
  }, [sessionId, refreshTools]);

  return {
    tools,
    isLoading,
    error,
    refreshTools: () => refreshTools(true),
    isUserActive: !!sessionId // Active when we have a session
  };
}; 