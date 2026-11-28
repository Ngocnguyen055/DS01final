/** Transport failure, distinct from a server rejecting a signaling request. */
export class SignalingTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalingTransportError";
  }
}
