export interface SseEvent {
  /** Payload — an object is JSON-encoded. */
  data: string | object;
  /** Event name the client listens for (`addEventListener(name, …)`). */
  event?: string;
  /** Event id; echoed to the client and resent as `Last-Event-ID` on reconnect. */
  id?: string;
  /** Reconnection delay hint, ms. */
  retry?: number;
}

/** Serialize an event into the `text/event-stream` wire format (a blank line ends it). */
export function formatEvent(event: SseEvent): string {
  let frame = "";
  // strip line terminators from single-line fields so a value can't inject extra frames
  if (event.id !== undefined) frame += `id: ${oneLine(event.id)}\n`;
  if (event.event !== undefined) frame += `event: ${oneLine(event.event)}\n`;
  if (event.retry !== undefined) frame += `retry: ${event.retry}\n`;
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  for (const line of data.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
  return `${frame}\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, "");
}
