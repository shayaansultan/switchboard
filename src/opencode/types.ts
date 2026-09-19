import { z } from 'zod';
import { ProfileId, Secrets } from '../storage';
export { ProfileId, Secrets } from '../storage';

export type ProfileId = z.infer<typeof ProfileId>;
export const ModelId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/)
  .brand<'ModelId'>();
export type ModelId = z.infer<typeof ModelId>;
// Native provider model names can contain slashes (e.g. an organization/model).
export const ModelRef = z.union([ModelId, z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[^\s]+$/)]);
export const ReasoningEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
export const Service = z.enum(['google-workspace', 'slack', 'linear', 'github', 'notion', 'wispr-flow']);
export type Service = z.infer<typeof Service>;
export const Access = z.enum(['read-only', 'read-write']);
export type Access = z.infer<typeof Access>;
export const ImportMode = z.enum(['copy', 'link']);
export type ImportMode = z.infer<typeof ImportMode>;
export const Identity = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('verified'),
    subject: z.string().min(1),
    scopes: z.array(z.string()),
    label: z.string(),
  }),
  z.object({ status: z.literal('source-only'), reason: z.string() }),
]);
export type Identity = z.infer<typeof Identity>;
export const Connection = z.object({
  backend: z.literal('codex-hosted'),
  bridge: z.string().min(1),
  codexHome: z.string().min(1),
  account: z.email(),
  access: Access,
  identity: Identity,
  serviceAccount: z.object({ email: z.email(), evidence: z.literal('user-confirmed') }).optional(),
});
export type Connection = z.infer<typeof Connection>;

const NativeAgents = z.object({
  claude: z.object({ configDir: z.string().min(1), account: z.email() }).optional(),
  codex: z.object({ home: z.string().min(1), account: z.email() }).optional(),
});
export const Profile = z.object({
  version: z.literal(1),
  id: ProfileId,
  name: z.string().min(1),
  createdAt: z.string(),
  model: ModelRef,
  poolModel: ModelId.optional(),
  smallModel: ModelRef.optional(),
  reasoningEffort: ReasoningEffort.default('low'),
  projectConfig: z.enum(['isolated', 'inherit']),
  connections: z.partialRecord(Service, Connection),
  nativeAgents: NativeAgents.optional(),
  githubLogin: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)
    .optional(),
});
export type Profile = z.infer<typeof Profile>;
export type Secrets = z.infer<typeof Secrets>;
export const ObjectValue = z.record(z.string(), z.unknown());
export type ObjectValue = z.infer<typeof ObjectValue>;
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
