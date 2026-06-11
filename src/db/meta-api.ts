import type { AdminBlobRecord, AdminUserRecord, BlobStats } from "./handle.ts";

interface MetaStatsResponse {
  blobCount: number;
  totalSize: number;
  dailyUploads: number;
}

interface MetaListBlobsResponse {
  items: AdminBlobRecord[];
}

interface MetaCountResponse {
  count: number;
}

interface MetaListUsersResponse {
  items: AdminUserRecord[];
}

function asUrl(
  baseUrl: string,
  path: string,
  params?: URLSearchParams,
): string {
  const url = new URL(path, baseUrl);
  if (params) {
    url.search = params.toString();
  }
  return url.toString();
}

export class MetaApiDbHandle {
  constructor(private readonly baseUrl: string) {}

  private async getJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json" },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `metadata API request failed (${response.status}): ${body}`,
      );
    }

    return await response.json() as T;
  }

  async getStats(): Promise<BlobStats> {
    const data = await this.getJson<MetaStatsResponse>(
      asUrl(this.baseUrl, "/__meta/stats"),
    );
    return {
      blobCount: data.blobCount,
      totalSize: data.totalSize,
      dailyUploads: data.dailyUploads,
    };
  }

  async listAllBlobs(opts?: {
    filter?: { q?: string; type?: string | string[] };
    sort?: [string, string];
    limit?: number;
    offset?: number;
  }): Promise<AdminBlobRecord[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));

    if (opts?.filter?.q) params.set("q", opts.filter.q);

    if (opts?.filter?.type !== undefined) {
      const types = Array.isArray(opts.filter.type)
        ? opts.filter.type
        : [opts.filter.type];
      if (types.length > 0) {
        params.set("type", types.join(","));
      }
    }

    if (opts?.sort) {
      params.set("sort", opts.sort[0]);
      params.set("dir", opts.sort[1]);
    }

    const data = await this.getJson<MetaListBlobsResponse>(
      asUrl(this.baseUrl, "/__meta/blobs", params),
    );
    return data.items;
  }

  async countBlobs(filter?: {
    q?: string;
    type?: string | string[];
  }): Promise<number> {
    const params = new URLSearchParams();
    if (filter?.q) params.set("q", filter.q);
    if (filter?.type !== undefined) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (types.length > 0) params.set("type", types.join(","));
    }

    const data = await this.getJson<MetaCountResponse>(
      asUrl(this.baseUrl, "/__meta/blobs/count", params),
    );
    return data.count;
  }

  async listAllUsers(opts?: {
    filter?: { q?: string; pubkey?: string };
    sort?: [string, string];
    limit?: number;
    offset?: number;
  }): Promise<AdminUserRecord[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.filter?.q) params.set("q", opts.filter.q);
    if (opts?.filter?.pubkey) params.set("pubkey", opts.filter.pubkey);
    if (opts?.sort) {
      params.set("sort", opts.sort[0]);
      params.set("dir", opts.sort[1]);
    }

    const data = await this.getJson<MetaListUsersResponse>(
      asUrl(this.baseUrl, "/__meta/users", params),
    );
    return data.items;
  }

  async countUsers(filter?: { q?: string; pubkey?: string }): Promise<number> {
    const params = new URLSearchParams();
    if (filter?.q) params.set("q", filter.q);
    if (filter?.pubkey) params.set("pubkey", filter.pubkey);

    const data = await this.getJson<MetaCountResponse>(
      asUrl(this.baseUrl, "/__meta/users/count", params),
    );
    return data.count;
  }
}
