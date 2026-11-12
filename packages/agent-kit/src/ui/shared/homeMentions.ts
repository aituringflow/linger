export interface HomeMentionTarget { id: string; name: string }

/** A completed @ token must end at a word boundary, so @dun does not match @duncan. */
export function hasHomeMention(draft: string, name: string): boolean {
  const token = `@${name}`;
  let at = draft.indexOf(token);
  while (at !== -1) {
    const after = draft[at + token.length];
    if (!after || /[\s@，。！？,.!?;；:：]/.test(after)) return true;
    at = draft.indexOf(token, at + token.length);
  }
  return false;
}

export function resolveHomeMentionTargets<Contact extends HomeMentionTarget, Group extends HomeMentionTarget>(
  draft: string, contacts: Contact[], groups: Group[], explicitGroup: Group | null,
): { contacts: Contact[]; group: Group | null; mixed: boolean; key: string } {
  const matchedContacts = contacts.filter(person => hasHomeMention(draft, person.name));
  const group = explicitGroup && hasHomeMention(draft, explicitGroup.name)
    ? explicitGroup
    : groups.find(item => hasHomeMention(draft, item.name) && !matchedContacts.some(person => person.name === item.name)) ?? null;
  const mixed = !!group && matchedContacts.some(person => person.name !== group.name);
  const selectedContacts = group ? [] : matchedContacts;
  const key = group ? `group:${group.id}` : selectedContacts.map(person => person.id).sort().join(",");
  return { contacts: selectedContacts, group, mixed, key };
}
