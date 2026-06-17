/** @-mentions inside a message body → bare names (priority/wake hint). Shared by the console
 *  palette and the headless `cotal msg` so both carry the same wake hints on a multicast. */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/@([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
}
