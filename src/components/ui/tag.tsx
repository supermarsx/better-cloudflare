import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const tagVariants = cva("ui-tag", {
  variants: {
    variant: {
      default: "",
      primary: "",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface TagProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof tagVariants> {}

export function Tag({ className, variant, ...props }: TagProps) {
  return (
    <span
      data-variant={variant ?? "default"}
      className={cn(tagVariants({ variant }), className)}
      {...props}
    />
  );
}

