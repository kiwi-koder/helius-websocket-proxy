export interface ClientSubscribeMessage {
  action: 'subscribe';
  method: string;
  params?: unknown[];
}

export interface ClientUnsubscribeMessage {
  action: 'unsubscribe';
  subscriptionId: string;
}

export type ClientMessage = ClientSubscribeMessage | ClientUnsubscribeMessage;

export interface ServerSubscribedMessage {
  type: 'subscribed';
  subscriptionId: string;
  method: string;
}

export interface ServerUnsubscribedMessage {
  type: 'unsubscribed';
  subscriptionId: string;
}

export interface ServerErrorMessage {
  type: 'error';
  message: string;
}
