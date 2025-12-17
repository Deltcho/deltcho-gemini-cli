/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import { promptIdContext } from '../../utils/promptIdContext.js';
import type {
  RoutingContext,
  RoutingDecision,
  RoutingStrategy,
} from '../routingStrategy.js';
import {
  DEFAULT_GEMINI_MODEL_AUTO_3,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
} from '../../config/models.js';
import { createUserContent, Type } from '@google/genai';
import type { Config } from '../../config/config.js';
import {
  isFunctionCall,
  isFunctionResponse,
} from '../../utils/messageInspectors.js';
import { debugLogger } from '../../utils/debugLogger.js';

// The number of recent history turns to provide to the router for context.
const HISTORY_TURNS_FOR_CONTEXT = 4;
const HISTORY_SEARCH_WINDOW = 20;

const FLASH_MODEL = 'flash';
const PRO_MODEL = 'pro';

const CLASSIFIER_SYSTEM_PROMPT = `
You are a specialized Task Routing AI. Your sole function is to analyze the user's request and classify its complexity. Choose between 
${FLASH_MODEL}
 (SIMPLE) or 
${PRO_MODEL}
 (COMPLEX).
1.  
${FLASH_MODEL}
: A fast, efficient model for simple, well-defined tasks.
2.  
${PRO_MODEL}
: A powerful, advanced model for complex, open-ended, or multi-step tasks.
<complexity_rubric>
A task is COMPLEX (Choose 
${PRO_MODEL}
) if it meets ONE OR MORE of the following criteria:
1.  **High Operational Complexity (Est. 4+ Steps/Tool Calls):** Requires dependent actions, significant planning, or multiple coordinated changes.
2.  **Strategic Planning & Conceptual Design:** Asking "how" or "why." Requires advice, architecture, or high-level strategy.
3.  **High Ambiguity or Large Scope (Extensive Investigation):** Broadly defined requests requiring extensive investigation.
4.  **Deep Debugging & Root Cause Analysis:** Diagnosing unknown or complex problems from symptoms.
A task is SIMPLE (Choose 
${FLASH_MODEL}
) if it is highly specific, bounded, and has Low Operational Complexity (Est. 1-3 tool calls). Operational simplicity overrides strategic phrasing.
</complexity_rubric>
**Output Format:**
Respond *only* in JSON format according to the following schema. Do not include any text outside the JSON structure.
{
  "type": "object",
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "A brief, step-by-step explanation for the model choice, referencing the rubric."
    },
    "model_choice": {
      "type": "string",
      "enum": ["${FLASH_MODEL}", "${PRO_MODEL}"]
    }
  },
  "required": ["reasoning", "model_choice"]
}
`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reasoning: {
      type: Type.STRING,
      description:
        'A brief, step-by-step explanation for the model choice, referencing the rubric.',
    },
    model_choice: {
      type: Type.STRING,
      enum: [FLASH_MODEL, PRO_MODEL],
    },
  },
  required: ['reasoning', 'model_choice'],
};

const ClassifierResponseSchema = z.object({
  reasoning: z.string(),
  model_choice: z.enum([FLASH_MODEL, PRO_MODEL]),
});

/**
 * A specialized router for the 'auto-3' model.
 * It uses the classifier to decide between Gemini 3 Pro and Gemini 3 Flash.
 */
export class Auto3Strategy implements RoutingStrategy {
  readonly name = 'auto-3';

  async route(
    context: RoutingContext,
    config: Config,
    baseLlmClient: BaseLlmClient,
  ): Promise<RoutingDecision | null> {
    if (config.getModel() !== DEFAULT_GEMINI_MODEL_AUTO_3) {
      return null;
    }

    const startTime = Date.now();
    try {
      let promptId = promptIdContext.getStore();
      if (!promptId) {
        promptId = `auto-3-router-fallback-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;
        debugLogger.warn(
          `Could not find promptId in context. This is unexpected. Using a fallback ID: ${promptId}`,
        );
      }

      const historySlice = context.history.slice(-HISTORY_SEARCH_WINDOW);
      const cleanHistory = historySlice.filter(
        (content) => !isFunctionCall(content) && !isFunctionResponse(content),
      );
      const finalHistory = cleanHistory.slice(-HISTORY_TURNS_FOR_CONTEXT);

      const jsonResponse = await baseLlmClient.generateJson({
        modelConfigKey: { model: 'classifier' },
        contents: [...finalHistory, createUserContent(context.request)],
        schema: RESPONSE_SCHEMA,
        systemInstruction: CLASSIFIER_SYSTEM_PROMPT,
        abortSignal: context.signal,
        promptId,
      });

      const routerResponse = ClassifierResponseSchema.parse(jsonResponse);
      const reasoning = routerResponse.reasoning;
      const latencyMs = Date.now() - startTime;

      if (routerResponse.model_choice === FLASH_MODEL) {
        return {
          model: PREVIEW_GEMINI_FLASH_MODEL,
          metadata: {
            source: 'Auto-3 (Classifier)',
            latencyMs,
            reasoning,
          },
        };
      } else {
        return {
          model: PREVIEW_GEMINI_MODEL,
          metadata: {
            source: 'Auto-3 (Classifier)',
            reasoning,
            latencyMs,
          },
        };
      }
    } catch (error) {
      debugLogger.warn(`[Routing] Auto3Strategy failed:`, error);
      return null;
    }
  }
}
