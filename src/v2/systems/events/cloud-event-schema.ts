export interface CloudEventSchema {
  id: string;
  source: string;
  type: string;
  specversion: '1.0';
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  data: unknown;
}
