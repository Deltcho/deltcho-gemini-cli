/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import { getErrorMessage } from '@google/gemini-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import type { ICommandLoader } from './types.js';
import * as path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

/**
 * Discovers and loads executable slash commands from prompts stored as text
 * files in the `.gemini/prompts` directory.
 */
export class FilePromptLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    if (!this.config) {
      return [];
    }

    const projectRoot = this.config.getProjectRoot();
    const promptsDir = path.join(projectRoot, '.gemini', 'prompts');

    try {
      const dirents = await readdir(promptsDir, { withFileTypes: true });
      const promptFiles = dirents
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.txt'))
        .map((dirent) => dirent.name);

      const promptCommands: SlashCommand[] = [];

      for (const file of promptFiles) {
        const commandName = `p-${path.basename(file, '.txt')}`;
        const filePath = path.join(promptsDir, file);

        try {
          const content = await readFile(filePath, 'utf-8');
          const firstLine = content.split('\n')[0].trim();
          const description =
            firstLine.length > 100
              ? `${firstLine.slice(0, 97)}...` 
              : firstLine;

          const newPromptCommand: SlashCommand = {
            name: commandName,
            description: `Workflow: ${description}`,
            kind: CommandKind.USER_DEFINED,
            action: async (
              _context: CommandContext,
              args: string,
            ): Promise<SlashCommandActionReturn> => {
              return {
                type: 'submit_prompt',
                content: `/${commandName} ${args}`,
              };
            },
          };
          promptCommands.push(newPromptCommand);
        } catch (error) {
          // Ignore files that can't be read.
        }
      }
      return promptCommands;
    } catch (error) {
      // If the directory doesn't exist, just return an empty array.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return [];
      }
      // For other errors, you might want to log them for debugging.
      console.error(
        `Error loading file prompts: ${getErrorMessage(error)}`,
      );
      return [];
    }
  }
}
