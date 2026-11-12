/**
 * Saving and opening files in the browser. Downloads use a Blob URL on a temporary <a download>
 * element: the CSP (D-009) restricts scripts, styles, workers and connections, not downloads, and
 * the Blob URL is revoked right after the click.
 */

export function downloadText(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Text of a file the user picked (an <input type="file"> change event). */
export async function readPickedFile(input: HTMLInputElement): Promise<{ name: string; text: string } | null> {
  const file = input.files?.[0];
  input.value = ""; // picking the same file again fires another change event
  if (!file) return null;
  return { name: file.name, text: await file.text() };
}
