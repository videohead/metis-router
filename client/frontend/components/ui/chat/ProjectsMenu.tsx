"use client";
import React from 'react';
import { LayoutGrid, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { projects } from '@/lib/projects';

const ProjectsMenu = () => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="text-gray-600 hover:text-gray-900">
          <LayoutGrid className="h-4 w-4 mr-2" />
          Explore Projects
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {projects.map((project) => (
          <DropdownMenuItem key={project.path} asChild>
            <a
              href={project.path}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between cursor-pointer"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{project.name}</span>
                <span className="text-xs text-gray-500">{project.description}</span>
              </div>
              <ExternalLink className="h-3 w-3 text-gray-400 ml-2 shrink-0" />
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProjectsMenu;
