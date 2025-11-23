declare module 'react-window' {
  import * as React from 'react';
  export type ListChildComponentProps = { index: number; style: React.CSSProperties };
  export function FixedSizeList(props: unknown): JSX.Element;
  export default FixedSizeList;
}
