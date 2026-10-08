/**
 * Reading a transcript's attribution.
 *
 * A conversation's provider, model and persona can now change mid-thread, so
 * `Conversation.provider` no longer describes the transcript — it describes
 * what the *next* turn will use. What each message actually ran under is
 * recorded on the message, in {@link ChatMessage.origin}, and this module is
 * how that record is turned into something a reader can act on.
 *
 * Three rules it keeps, all of them about not lying:
 *
 * **An id that no longer resolves is shown, never guessed at.** A provider
 * profile or a persona can be deleted while the transcript that used it
 * survives, so every label here is accompanied by whether it *resolved*.
 * Substituting some other provider's name for an unresolved id would claim the
 * wrong endpoint saw the transcript, which is the whole defect the per-message
 * attribution exists to prevent. This is the same policy the conversation tab
 * strip already applies to a conversation's own provider id.
 *
 * **A switch is marked where it happened, and nowhere else.** {@link
 * aiOriginChanges} reports only the messages whose attribution differs from the
 * previous attributed message, so a conversation that never switched costs the
 * transcript no extra height at all — which is what lets the same renderer
 * serve the workspace tab, the 22rem dock and the 26rem bubble. The *first*
 * attributed message is deliberately not a change: there is nothing to have
 * switched from, and marking it would put a row on every conversation to
 * restate what the composer dock already says.
 *
 * **Every field counts as the attribution.** Including the two `missing*`
 * fields: a user who chose a second persona that had also been deleted changed
 * something, even though the prompt that ran is the same fallback both times.
 * Comparing all five needs no special cases and cannot hide a failed choice.
 */
import type {
  AiPersona,
  AiProviderProfile,
  ChatMessage,
  MessageOrigin,
} from "@/types/ai";

/** The catalogues an id is resolved against. */
export interface AiOriginCatalogues {
  providers: readonly AiProviderProfile[];
  personas: readonly AiPersona[];
}

/**
 * One attribution, with every id resolved as far as it can be.
 *
 * The `*Resolved` flags exist so a caller can *say* that a name is a bare id
 * rather than printing it as though it were a label. Nothing here is
 * translated: these are names and ids, and the words around them belong to the
 * component that has `t`.
 */
export interface AiOriginSummary {
  /** The profile's label, or the bare id when it no longer resolves. */
  provider: string;
  providerResolved: boolean;
  model: string;
  /**
   * The persona's name, or its bare id when it no longer resolves, or `null`
   * when the turn sent no persona prompt at all — which also covers a
   * conversation whose own `systemPrompt` outranked the persona.
   */
  persona: string | null;
  personaResolved: boolean;
  /** A persona that was asked for and did not exist, as a bare id. */
  missingPersonaId: string | null;
  /** A profile that was asked for and was not configured, as a bare id. */
  missingProviderId: string | null;
}

/** The profile's label, or the bare id when it no longer resolves. */
export function aiProviderLabel(
  id: string,
  providers: readonly AiProviderProfile[],
): string {
  return providers.find((entry) => entry.id === id)?.label ?? id;
}

/** The persona's name, or the bare id when it no longer resolves. */
export function aiPersonaLabel(
  id: string,
  personas: readonly AiPersona[],
): string {
  return personas.find((entry) => entry.id === id)?.name ?? id;
}

export function summarizeAiOrigin(
  origin: MessageOrigin,
  { providers, personas }: AiOriginCatalogues,
): AiOriginSummary {
  const profile = providers.find((entry) => entry.id === origin.provider);
  const persona = origin.personaId
    ? (personas.find((entry) => entry.id === origin.personaId) ?? null)
    : null;
  return {
    provider: profile?.label ?? origin.provider,
    providerResolved: profile !== undefined,
    model: origin.model,
    persona: origin.personaId ? (persona?.name ?? origin.personaId) : null,
    personaResolved: persona !== null,
    missingPersonaId: origin.missingPersonaId ?? null,
    missingProviderId: origin.missingProviderId ?? null,
  };
}

/** Whether two attributions describe the same turn conditions. */
export function sameAiOrigin(
  left: MessageOrigin,
  right: MessageOrigin,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.personaId === right.personaId &&
    left.missingPersonaId === right.missingPersonaId &&
    left.missingProviderId === right.missingProviderId
  );
}

/** A message that begins a new set of turn conditions. */
export interface AiOriginChange {
  /** What the messages from here on ran under. */
  origin: MessageOrigin;
  /** What the messages before it ran under. */
  previous: MessageOrigin;
}

/**
 * The messages whose attribution differs from the previous attributed
 * message, keyed by message id.
 *
 * Unattributed messages — tool results, and anything recorded before
 * attribution existed — are skipped rather than treated as a change: they
 * carry no claim about which model produced them, so they cannot contradict
 * one either. That is also what keeps a tool round from appearing to switch
 * models halfway through.
 */
export function aiOriginChanges(
  messages: readonly ChatMessage[],
): ReadonlyMap<string, AiOriginChange> {
  const changes = new Map<string, AiOriginChange>();
  let previous: MessageOrigin | null = null;
  for (const message of messages) {
    const origin = message.origin;
    if (!origin) continue;
    if (previous !== null && !sameAiOrigin(previous, origin)) {
      changes.set(message.id, { origin, previous });
    }
    previous = origin;
  }
  return changes;
}
