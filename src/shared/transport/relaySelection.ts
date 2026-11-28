export type RelaySample = {
  url: string;
  rttMs: number;
  peers: number;
  pending: number;
  score: number;
  sampledAt: number;
};
export class RelaySelector {
  readonly samples = new Map<string, RelaySample>();
  update(
    url: string,
    rttMs: number,
    peers: number,
    pending: number,
    now = Date.now(),
  ) {
    if (
      ![rttMs, peers, pending].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    )
      throw Error("invalid relay metrics");
    const prior = this.samples.get(url),
      rtt = prior ? prior.rttMs * 0.7 + rttMs * 0.3 : rttMs;
    const value = {
      url,
      rttMs: rtt,
      peers,
      pending,
      score: rtt + peers * 0.25 + pending * 2,
      sampledAt: now,
    };
    this.samples.set(url, value);
    return value;
  }
  rank(urls: string[], current?: string, now = Date.now()) {
    const score = (url: string) => {
      const sample = this.samples.get(url);
      return sample && now - sample.sampledAt < 45000 ? sample.score : Infinity;
    };
    return [...urls].sort((a, b) => {
      const left = score(a) * (a === current ? 0.9 : 1),
        right = score(b) * (b === current ? 0.9 : 1);
      return left - right || urls.indexOf(a) - urls.indexOf(b);
    });
  }
}
