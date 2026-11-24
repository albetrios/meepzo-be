/** A person the trusted-device calls act for: the internal id (row filter) and the public id (RLS context). */
export interface TrustedDeviceOwner {
  id: number;
  public_id: string;
}
