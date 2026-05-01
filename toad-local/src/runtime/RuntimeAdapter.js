export class RuntimeAdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RuntimeAdapterError';
    this.details = details;
  }
}

export class RuntimeAdapter {
  constructor(providerId) {
    if (new.target === RuntimeAdapter) {
      throw new TypeError('RuntimeAdapter is an abstract base class');
    }
    this.providerId = providerId;
  }

  async launch() {
    throw new RuntimeAdapterError('launch() is not implemented', { providerId: this.providerId });
  }

  async stop() {
    throw new RuntimeAdapterError('stop() is not implemented', { providerId: this.providerId });
  }

  async sendTurn() {
    throw new RuntimeAdapterError('sendTurn() is not implemented', { providerId: this.providerId });
  }

  events() {
    throw new RuntimeAdapterError('events() is not implemented', { providerId: this.providerId });
  }

  async approve() {
    throw new RuntimeAdapterError('approve() is not implemented', { providerId: this.providerId });
  }

  async health() {
    throw new RuntimeAdapterError('health() is not implemented', { providerId: this.providerId });
  }
}

