export type AccountOptions = {
  private?: string;
  address?: string;

  phrases?: string[];
};

export interface Account<Options extends AccountOptions> {
  readonly options: Options;

  getBalance(address?: string): Promise<bigint | number>;
}
