export interface AccountIdentity {
  id: string;
  name: string | null;
}

export interface AccountContact {
  id?: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}

export function toAccount(contact: AccountContact | null | undefined): AccountIdentity | null {
  if (!contact?.id) {
    return null;
  }

  const user = contact.id.split('@')[0] ?? '';
  const id = user.split(':')[0] ?? '';
  if (!id) {
    return null;
  }

  const name =
    [contact.name, contact.verifiedName, contact.notify].find(
      (value) => typeof value === 'string' && value.trim().length > 0,
    ) ?? null;

  return { id, name };
}
