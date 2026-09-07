"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Paperclip,
  ChevronRight,
} from "lucide-react";
import { useChatStore } from "@/lib/stores/chatStore";
import apiService from "@/lib/services/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import ToolList, { ToolListRef } from "./ToolList";

const ChatComposer = () => {
  const [input, setInput] = useState("");

  const [backendStatus, setBackendStatus] = useState<
    "connected" | "disconnected" | "checking"
  >("checking");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    sessionId,
    isConnecting,
    sendMessage,
    isTyping,
  } = useChatStore();

  // Get refresh function from ToolList's polling hook
  const toolListRef = useRef<ToolListRef>(null);

  const isSessionActive = !!sessionId;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  // Check backend connection on mount
  useEffect(() => {
    const checkBackendConnection = async () => {
      try {
        await apiService.healthCheck();
        setBackendStatus("connected");
      } catch {
        setBackendStatus("disconnected");
      }
    };

    checkBackendConnection();

    // Check every 30 seconds
    const interval = setInterval(checkBackendConnection, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isConnecting || isTyping) return;

    const userInput = input;

    // Send message using the simplified system
    const success = await sendMessage(userInput);

    if (success) {
      setInput("");
    } else {
      console.error("Failed to send message");
    }
  };

  const handleToolClick = (toolName: string) => {
    setInput(`/${toolName} `);
    textareaRef.current?.focus();
  };

  const handleFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="border-t bg-white h-full flex flex-col">
      <div className="w-3/4 mx-auto p-4 flex-1 flex flex-col overflow-hidden">
        {/* Input Form */}
        <form onSubmit={handleSubmit} className="space-y-4 flex-shrink-0">
          <div className="relative flex items-center space-x-2">
            <div className="flex-1 relative">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  isSessionActive 
                    ? "Type your message... (Press Enter to send, Shift+Enter for new line)"
                    : "Start a conversation..."
                }
                className="min-h-[60px] max-h-[200px] resize-none pr-12 text-sm"
                disabled={isConnecting || isTyping}
              />
              
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute bottom-2 right-2 h-8 w-8"
                onClick={handleFileUpload}
                disabled={isConnecting || isTyping}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>

            {/* Send Button - Now inline to the right */}
            <Button
              type="submit"
              disabled={
                !input.trim() || 
                isConnecting || 
                isTyping ||
                backendStatus !== "connected"
              }
              className="h-12 w-12 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl flex-shrink-0"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-500">
              {/* Typing indicator removed */}
            </div>
          </div>
        </form>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setInput((prev) => prev + `\n[Attached: ${file.name}]`);
            }
          }}
        />

        {/* Dynamic Tool List - Now scrollable */}
        <div className="flex-1 mt-4 min-h-0 overflow-y-auto">
          <ToolList 
            onToolClick={handleToolClick} 
            ref={toolListRef}
            sessionId={sessionId}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatComposer;
