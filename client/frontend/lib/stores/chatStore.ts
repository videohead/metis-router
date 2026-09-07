"use client";

import { create } from 'zustand';
import apiService from '../services/api';

export interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  streamingComplete?: boolean;
  toolCalls?: ToolCall[];
  rating?: 'up' | 'down';
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'success';
  duration?: number;
}

interface ChatState {
  messages: Message[];
  isTyping: boolean;
  darkMode: boolean;
  
  // Session management
  sessionId: string | null;
  isConnecting: boolean;
  connectionError: string | null;
  
  // Actions
  autoConnect: () => void;
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>, providedId?: string) => void;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  clearMessages: () => void;
  toggleDarkMode: () => void;
  setTyping: (typing: boolean) => void;
  rateMessage: (messageId: string, rating: 'up' | 'down') => void;
  
  // Session actions
  connectSession: () => Promise<boolean>;
  sendMessage: (content: string) => Promise<boolean>;
  updateStreamingMessage: (messageId: string, chunk: string) => void;
  completeStreamingMessage: (messageId: string) => void;
  
  // Tool call actions
  addToolCall: (messageId: string, toolCall: Omit<ToolCall, 'id'>, call_id: string) => void;
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCall>) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isTyping: false,
  darkMode: false,
  
  // Session state
  sessionId: null,
  isConnecting: false,
  connectionError: null,

  autoConnect: () => {
    const state = get();
    if (!state.sessionId && !state.isConnecting) {
      get().connectSession();
    }
  },

  addMessage: (message, providedId) => {
    const newMessage = {
      ...message,
      id: providedId || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date()
    };
    
    set((state) => ({
      messages: [...state.messages, newMessage]
    }));
  },

  updateMessage: (messageId, updates) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId ? { ...msg, ...updates } : msg
    )
  })),

  clearMessages: () => set({ messages: [] }),

  toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),

  setTyping: (typing) => set({ isTyping: typing }),

  // Connect session using SSE
  connectSession: async () => {
    const state = get();
    
    // If already connected, return true
    if (state.sessionId) {
      return true;
    }

    set({ isConnecting: true, connectionError: null });

    try {
      // Convert messages to chat history format
      const chatHistory = state.messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const response = await apiService.connect(chatHistory);
      
      if (response.success) {
        set({
          sessionId: response.session_id,
          isConnecting: false
        });
        return true;
      }
    } catch (error) {
      console.error('❌ Failed to connect session:', error);
      set({ 
        isConnecting: false, 
        connectionError: error instanceof Error ? error.message : 'Connection failed' 
      });
    }

    return false;
  },

  sendMessage: async (content) => {
    const state = get();
    
    // Ensure session is connected
    if (!state.sessionId) {
      const connected = await get().connectSession();
      if (!connected) {
        console.error('❌ Failed to connect session');
        return false;
      }
    }

    const sessionId = get().sessionId;
    if (!sessionId) {
      console.error('❌ Session ID missing');
      return false;
    }

    // Add user message
    get().addMessage({
      content,
      role: 'user'
    });

    // Add streaming placeholder for assistant response
    const assistantMessageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    get().addMessage({
      content: '',
      role: 'assistant',
      isStreaming: true,
      streamingComplete: false
    }, assistantMessageId);

    set({ isTyping: true });

    try {
      // Send message to backend
      const sendResponse = await apiService.sendMessage(sessionId, content);
      
      if (!sendResponse.success) {
        throw new Error('Failed to send message');
      }
      
      // Start SSE stream for response
      const activeToolCalls = new Set<string>();
      
      await apiService.streamResponse(
        sessionId,
        // onToken
        (tokenContent) => {
          get().updateStreamingMessage(assistantMessageId, tokenContent);
        },
        // onToolCall
        (toolCall) => {
          if (toolCall.name && toolCall.call_id) {
            if (activeToolCalls.has(toolCall.call_id)) {
              const updates: Partial<ToolCall> = {
                status: toolCall.arguments ? 'running' : 'pending'
              };
              
              if (toolCall.arguments) {
                updates.input = toolCall.arguments;
              }
              
              get().updateToolCall(assistantMessageId, toolCall.call_id, updates);
            } else {
              get().addToolCall(assistantMessageId, {
                name: toolCall.name,
                input: toolCall.arguments,
                status: toolCall.arguments ? 'running' : 'pending'
              }, toolCall.call_id);
              
              activeToolCalls.add(toolCall.call_id);
            }
          }
        },
        // onToolResponse
        (response) => {
          if (response.call_id && activeToolCalls.has(response.call_id)) {
            let responseText: string | Record<string, unknown> = response.output;
            if (response.output && typeof response.output === 'object' && 'text' in response.output) {
              const textValue = (response.output as { text: unknown }).text;
              if (typeof textValue === 'string') {
                responseText = textValue;
              }
            }
            
            get().updateToolCall(assistantMessageId, response.call_id, {
              output: responseText,
              status: 'success'
            });
          }
        },
        // onCompletion
        () => {
          get().completeStreamingMessage(assistantMessageId);
          set({ isTyping: false });
        },
        // onError
        (error) => {
          console.error('❌ Stream error:', error);
          get().updateMessage(assistantMessageId, {
            content: `Sorry, I could not complete your request. ${error || 'The response stream ended unexpectedly.'}`,
            isStreaming: false,
            streamingComplete: true
          });
          set({ isTyping: false });
        }
      );

      return true;
    } catch (error) {
      console.error('❌ Send message error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      get().updateMessage(assistantMessageId, {
        content: `Sorry, I could not send your message. ${errorMessage || 'The backend did not provide an error message.'}`,
        isStreaming: false,
        streamingComplete: true
      });
      set({ isTyping: false });
      return false;
    }
  },

  updateStreamingMessage: (messageId, chunk) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId && msg.isStreaming
        ? { ...msg, content: msg.content + chunk }
        : msg
    )
  })),

  completeStreamingMessage: (messageId) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId
        ? { ...msg, isStreaming: false, streamingComplete: true }
        : msg
    )
  })),

  addToolCall: (messageId, toolCall, call_id) => {
    const newToolCall = {
      ...toolCall,
      id: call_id
    };
    
    set((state) => ({
      messages: state.messages.map(msg =>
        msg.id === messageId
          ? {
              ...msg,
              toolCalls: [...(msg.toolCalls || []), newToolCall]
            }
          : msg
      )
    }));
  },

  updateToolCall: (messageId, toolCallId, updates) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId
        ? {
            ...msg,
            toolCalls: (msg.toolCalls || []).map(toolCall =>
              toolCall.id === toolCallId ? { ...toolCall, ...updates } : toolCall
            )
          }
        : msg
    )
  })),

  rateMessage: (messageId, rating) => set((state) => ({
    messages: state.messages.map(msg =>
      msg.id === messageId ? { ...msg, rating } : msg
    )
  })),
}));
