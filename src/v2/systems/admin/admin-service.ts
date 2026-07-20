export interface AdminService {
  replay(deliveryId: string): Promise<void>;
}
