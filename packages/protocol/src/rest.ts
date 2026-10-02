import { z } from 'zod';
import { AgentRole, AgentRuntime, TaskPriority } from './enums.js';
import type { ControlAction as ControlActionType } from './commands.js';
import {
  AgentCaps,
  PERMISSION_POLICY_PRESETS,
  PermissionPolicy,
  type PermissionPolicyPreset,
} from './domain.js';
import { ControlTarget } from './events.js';

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

/**
 * A panel action (decision 11b, P2-14), as `DomainCommands.control` takes it. Edit carries the
 * fields the panel may change: a task's description and priority, a project's name and its
 * permission policy (`null` returns it to the global default; a remote client's choice is floored
 * at the global default, P2-21).
 */
export const ControlActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({
    action: z.literal('edit'),
    changes: z
      .object({
        description: z.string().min(1).optional(),
        priority: TaskPriority.optional(),
        name: z.string().min(1).optional(),
        permissionPolicy: PermissionPolicy.nullable().optional(),
      })
      .strict(),
  }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('pin'), pinned: z.boolean() }),
  z.object({ action: z.literal('reopen') }),
]);

/** `POST /api/control`: one control action on a task, project or agent. */
export const ControlBody = z.object({ target: ControlTarget, action: ControlActionBody });
export type ControlBody = z.infer<typeof ControlBody>;

/** The acknowledgement; the events themselves arrive on the stream. */
export const ControlResponse = z.object({
  ok: z.literal(true),
  seq: z.number().int().nonnegative(),
});
export type ControlResponse = z.infer<typeof ControlResponse>;

// A parsed body is a valid `ControlAction` (compile-time check).
const _controlAction: (b: ControlBody['action']) => ControlActionType = (b) => b;
void _controlAction;
