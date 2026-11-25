export type Delivery = {
  id: string;
  url: string;
  body: string;
  state: string;
  attempts: number;
  next_at: number;
  lease_until: number | null;
  lease_token: string | null;
  key: string;
  fingerprint: string;
  generation: number;
};
