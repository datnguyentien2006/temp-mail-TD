/**
 * Tiny error helper shared by the provider layer.
 *
 * Providers throw errors that already carry the HTTP status the REST layer
 * should use. Messages are always safe to show to the client: provider code
 * must never put a sid_token or other secret in here.
 */

export function providerError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  return error;
}

export function statusForError(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return 500;
}