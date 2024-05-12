export type TransactOptions = {
  method?: string;
};

export interface Transact<Options extends TransactOptions> {
  readonly options: Options;

  transfer(method?: string, options?: TransactOptions): Promise<bigint>;
}
