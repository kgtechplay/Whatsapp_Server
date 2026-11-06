import { parsePhoneNumberFromString } from 'libphonenumber-js';

const ALLOWED_CHARACTERS = /^\+?[0-9][0-9\s().-]*$/;

export function normalizeRecipient(input: string): string | null {
  const trimmed = input.trim();
  if (!ALLOWED_CHARACTERS.test(trimmed)) {
    return null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return null;
  }
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (!parsed?.isValid()) {
    return null;
  }
  const normalized = parsed.number.startsWith('+') ? parsed.number.slice(1) : parsed.number;
  if (!/^[1-9]\d{7,14}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function toWhatsAppJid(normalizedPhoneNumber: string): string {
  return `${normalizedPhoneNumber}@s.whatsapp.net`;
}

export function maskPhoneNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  const lastFour = digits.slice(-4);
  return `***${lastFour.padStart(4, '*')}`;
}
