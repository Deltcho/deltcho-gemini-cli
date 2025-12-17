/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Auto3Strategy } from './auto3Strategy.js';
import {
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_MODEL_AUTO_3,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
} from '../../config/models.js';
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext } from '../routingStrategy.js';

describe('Auto3Strategy', () => {
  let strategy: Auto3Strategy;
  let mockConfig: Config;
  let mockBaseLlmClient: BaseLlmClient;
  let mockContext: RoutingContext;

  beforeEach(() => {
    strategy = new Auto3Strategy();
    mockConfig = {
      getModel: vi.fn(),
    } as unknown as Config;
    mockBaseLlmClient = {
      generateJson: vi.fn(),
    } as unknown as BaseLlmClient;
    mockContext = {
      history: [],
      request: [{ text: 'test' }],
      signal: new AbortController().signal,
    };
  });

  it('should return null if model is NOT auto-3', async () => {
    vi.mocked(mockConfig.getModel).mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO);
    const result = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
    );
    expect(result).toBeNull();
  });

  it('should return PREVIEW_GEMINI_MODEL if classifier returns pro', async () => {
    vi.mocked(mockConfig.getModel).mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO_3);
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      model_choice: 'pro',
      reasoning: 'complex task',
    });

    const result = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
    );

    expect(result).not.toBeNull();
    expect(result?.model).toBe(PREVIEW_GEMINI_MODEL);
    expect(result?.metadata.source).toBe('Auto-3 (Classifier)');
  });

  it('should return PREVIEW_GEMINI_FLASH_MODEL if classifier returns flash', async () => {
    vi.mocked(mockConfig.getModel).mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO_3);
    vi.mocked(mockBaseLlmClient.generateJson).mockResolvedValue({
      model_choice: 'flash',
      reasoning: 'simple task',
    });

    const result = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
    );

    expect(result).not.toBeNull();
    expect(result?.model).toBe(PREVIEW_GEMINI_FLASH_MODEL);
    expect(result?.metadata.source).toBe('Auto-3 (Classifier)');
  });

  it('should return null if classifier fails', async () => {
    vi.mocked(mockConfig.getModel).mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO_3);
    vi.mocked(mockBaseLlmClient.generateJson).mockRejectedValue(
      new Error('API Error'),
    );

    const result = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
    );

    expect(result).toBeNull();
  });
});
