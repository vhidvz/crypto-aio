import { InterfaceAbi } from 'ethers';
import { ContractAbi } from 'web3';

export type ContractOptions = {
  contract?: string;
  abi?: ContractAbi | InterfaceAbi;
};

export interface Contract<Options extends ContractOptions> {
  readonly options: Options;

  estimateGas(method?: string, options?: ContractOptions): Promise<bigint>;
}
