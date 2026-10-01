import { z } from 'zod';
import { AgentRole, AgentRuntime } from './enums.js';
import { AgentCaps, PERMISSION_POLICY_PRESETS, type PermissionPolicyPreset } from './domain.js';

// ---------------------------------------------------------------------------
// The small REST control surface (TECHNOLOGY §2.2; the ops console of P1-11). Results arrive on
// the WebSocket stream; these bodies only carry the request and its acknowledgement.
// ---------------------------------------------------------------------------

/** The names of the permission policy presets, derived from the presets themselves. */
export const PermissionPolicyPresetName = z.enum(
  Object.keys(PERMISSION_POLICY_PRESETS) as [PermissionPolicyPreset, ...PermissionPolicyPreset[]],
);

/** `POST /api/agents`. */
export const SpawnBody = z.object({
  role: AgentRole.default('steward'),
  runtime: AgentRuntime,
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  workspace: z.string().min(1).optional(),
  policy: PermissionPolicyPresetName.default('default'),
  caps: AgentCaps.partial().optional(),
  bare: z.boolean().optional(),
});
/** What a client sends (defaults not applied yet). */
export type SpawnBody = z.input<typeof SpawnBody>;

export const SpawnResponse = z.object({ agentId: z.string().min(1) });
export type SpawnResponse = z.infer<typeof SpawnResponse>;

/** `POST /api/agents/:id/send`. */
export const SendBody = z.object({ text: z.string().min(1), interrupt: z.boolean().optional() });
export type SendBody = z.infer<typeof SendBody>;

export const SendResponse = z.object({ messageId: z.string().min(1) });
export type SendResponse = z.infer<typeof SendResponse>;

/** `POST /api/questions/:id/answer`. */
export const AnswerBody = z.object({ answer: z.string().min(1) });
export type AnswerBody = z.infer<typeof AnswerBody>;

/** `GET /api/runtimes`: what the spawn form can offer. */
export const RuntimesInfo = z.object({
  runtimes: z.array(
    z.object({
      name: AgentRuntime,
      resumable: z.boolean(),
      /** Fake-adapter scenario names (dev mode). */
      scenarios: z.array(z.string()).optional(),
    }),
  ),
  policies: z.array(PermissionPolicyPresetName),
  caps: AgentCaps,
  maxConcurrentAgents: z.number().int().positive(),
});
export type RuntimesInfo = z.infer<typeof RuntimesInfo>;
