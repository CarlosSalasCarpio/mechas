/** Yacimiento de metal: ocupa una casilla y se agota. */
export interface MetalNode {
  readonly id: number;
  readonly tx: number;
  readonly ty: number;
  amount: number;
}

/** Metal que un obrero carga antes de volver a entregarlo. */
export const CARRY = 10;
/** Ticks por unidad de metal extraída. */
export const GATHER_TICKS = 14;
