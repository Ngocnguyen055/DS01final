import { z } from "zod";
import { groupSchema, peerIdSchema } from "@ds01/shared";
export const persistedSignalSchema = z.object({
  identities: z.array(
    z.tuple([peerIdSchema, z.string().regex(/^[a-f0-9]{64}$/)]),
  ),
  groups: z.array(
    groupSchema.refine(
      (group) => !group.projectId,
      "project groups are managed externally",
    ),
  ),
});
export type PersistedSignal = z.infer<typeof persistedSignalSchema>;
