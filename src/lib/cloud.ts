import crypto from 'node:crypto';
import os from 'node:os';

class CloudBackend {
  private apiUrl: string;
  private apiKey: string;
  private machineId: string;
  private headers: Record<string, string>;

  constructor(apiUrl: string, apiKey: string, machineId?: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.machineId = machineId || this.generateMachineId();
    this.headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  generateMachineId(): string {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();

    let mac = '';
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) continue;
      for (const addr of addrs) {
        if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
          mac = addr.mac;
          break;
        }
      }
      if (mac) break;
    }

    const raw = `${hostname}-${platform}-${arch}-${mac}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return hash.substring(0, 16);
  }

  async registerMachine(name?: string): Promise<any> {
    const response = await this.request('POST', '/api/machines/register', {
      machine_id: this.machineId,
      name: name || os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      python_version: process.version,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Failed to register machine: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async push(state: Record<string, any>, cryptoManager: any, metadata?: Record<string, any>): Promise<void> {
    state.machine = {
      id: this.machineId,
      hostname: os.hostname(),
      platform: os.platform(),
      pushed_at: new Date().toISOString(),
    };

    const stateJson = JSON.stringify(state);
    const encrypted = cryptoManager.encrypt(Buffer.from(stateJson));
    const encryptedBase64 = Buffer.from(encrypted).toString('base64');

    const response = await this.request('POST', `/api/machines/${this.machineId}/push`, {
      machine_id: this.machineId,
      encrypted_state: encryptedBase64,
      timestamp: new Date().toISOString(),
      version: '1.0',
      metadata,
    });

    if (!response.ok) {
      throw new Error(`Failed to push state: ${response.status} ${response.statusText}`);
    }
  }

  async pull(cryptoManager: any, machineId?: string): Promise<Record<string, any> | null> {
    const url = machineId
      ? `/api/machines/latest?machine_id=${machineId}`
      : '/api/machines/latest';
    const response = await this.request('GET', url);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to pull state: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const encryptedBuffer = Buffer.from(data.encrypted_state, 'base64');
    const decrypted = cryptoManager.decrypt(encryptedBuffer);
    return JSON.parse(decrypted.toString());
  }

  async listMachines(): Promise<any[]> {
    const response = await this.request('GET', '/api/machines');

    if (!response.ok) {
      throw new Error(`Failed to list machines: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.machines;
  }

  async deleteMachine(machineId?: string): Promise<boolean> {
    const response = await this.request('DELETE', `/api/machines/${machineId || this.machineId}`);
    return response.ok;
  }

  async verifyToken(): Promise<boolean> {
    const response = await this.request('GET', '/api/auth/verify');
    return response.ok;
  }

  async getActions(): Promise<any[]> {
    const response = await this.request('GET', `/api/machines/${this.machineId}/actions`);
    if (!response.ok) return [];
    const data = await response.json() as any;
    return data.actions || [];
  }

  async clearActions(): Promise<void> {
    await this.request('DELETE', `/api/machines/${this.machineId}/actions`);
  }

  async getEnvironments(): Promise<any[]> {
    const response = await this.request('GET', '/api/environments');
    if (!response.ok) return [];
    const data = await response.json() as any;
    return data.environments || [];
  }

  async syncEnvironments(environments: any[]): Promise<any[]> {
    const response = await this.request('PUT', '/api/environments/sync', { environments });
    if (!response.ok) {
      throw new Error(`Failed to sync environments: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as any;
    return data.environments || [];
  }

  private async request(method: string, path: string, body?: any): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    const options: RequestInit = { method, headers: this.headers };
    if (body) options.body = JSON.stringify(body);
    return fetch(url, options);
  }
}

export default CloudBackend;
