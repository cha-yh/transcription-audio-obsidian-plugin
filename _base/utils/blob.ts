/**
 * Wraps bytes for upload without a base64 detour.
 *
 * The resumable upload only needs `size` and `slice`, so the bytes read from
 * the vault can go straight to the wire. Encoding them to base64 first cost an
 * extra copy at ~1.37x the original and required Node's `Buffer` to decode,
 * which does not exist in the mobile WebView.
 */
export function toBlob(data: ArrayBuffer, mimeType: string): Blob {
  return new Blob([data], { type: mimeType || "application/octet-stream" });
}
