// Minimal SSE broadcast, in-process only. The UI subscribes and refetches
// its current view when notified - this is not a data channel, just a
// "something changed, go re-read it" signal.
const clients = new Set();

export function subscribe(res) {
  clients.add(res);
}

export function unsubscribe(res) {
  clients.delete(res);
}

export function broadcast(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}
