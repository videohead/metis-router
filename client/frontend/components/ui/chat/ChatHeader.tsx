"use client";
import React from 'react';
import { useChatStore } from '@/lib/stores/chatStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ProjectsMenu from './ProjectsMenu';

const ChatHeader = () => {
  const { clearMessages } = useChatStore();
  
  return (
    <div className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6">
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2">
          <h1 className="text-lg font-semibold text-gray-900">
            Metis Playground
          </h1>
          <Badge variant="secondary" className="bg-indigo-100 text-indigo-700">
            AI Assistant
          </Badge>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        <ProjectsMenu />
        <Button
          variant="outline"
          size="sm"
          onClick={clearMessages}
          className="text-gray-600 hover:text-gray-900"
        >
          Clear Chat
        </Button>
      </div>
    </div>
  );
};

export default ChatHeader;
