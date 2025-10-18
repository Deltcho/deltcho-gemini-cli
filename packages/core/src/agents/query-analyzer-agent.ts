/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition, AgentInputs } from './types.js';
import { ReadFileTool } from '../tools/read-file.js';
import { GLOB_TOOL_NAME } from '../tools/tool-names.js';
import { GrepTool } from '../tools/grep.js';
import { z } from 'zod';

const RelevantFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        lines: z.array(z.number()).optional(),
      }),
    )
    .describe("A list of files relevant to the user's query."),
});

/**
 * An agent that analyzes the user\'s query and the codebase to identify
 * relevant files.
 */
export const QueryAnalysisAgent: AgentDefinition<typeof RelevantFilesSchema> = {
  name: 'query_analyzer',
  displayName: 'Query Analyzer Agent',
  description: 'Analyzes the user query and codebase to find relevant files.',
  inputConfig: {
    inputs: {
      query: {
        description: "The user's query.",
        type: 'string',
        required: true,
      },
    },
  },
  outputConfig: {
    outputName: 'relevant_files',
    description: 'A list of relevant files and line numbers as a JSON object.',
    schema: RelevantFilesSchema,
  },
  processOutput: (output) => JSON.stringify(output, null, 2),
  modelConfig: {
    model: 'gemini-2.5-flash',
    temp: 0.2,
    top_p: 1,
    thinkingBudget: 0,
  },
  runConfig: {
    max_time_minutes: 5,
  },
  toolConfig: {
    tools: [ReadFileTool.Name, GLOB_TOOL_NAME, GrepTool.Name],
  },
  promptConfig: {
    query: (inputs: AgentInputs) =>
      `Analyze the following user query and the provided codebase to identify the most relevant files and lines.\n\nUser Query:\n<query>\n${inputs['query']}\n</query>\n\nYour task is to return a JSON object with a list of relevant files. For each file, include the path and, if possible, a list of relevant line numbers.`,
    systemPrompt: `You are an AI assistant that specializes in analyzing user queries and codebases to identify relevant files. Your goal is to provide a structured list of files that will help the main AI agent to fulfill the user's request.\n\nYou have access to the following tools to help you:\n- \`read_file\`: Reads the content of a file.\n- \`glob\`: Finds files matching a glob pattern.\n- \`grep\`: Searches for a pattern in files.\n\nUse these tools to explore the codebase and identify the most relevant files and lines for the given user query.`,
  },
};
