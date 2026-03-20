import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-mono text-[11px] uppercase tracking-[0.16em] transition-all duration-200 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-cream text-ink shadow-[0_12px_30px_rgba(239,246,224,0.18)] hover:-translate-y-0.5 hover:shadow-[0_16px_32px_rgba(239,246,224,0.24)]",
        secondary:
          "bg-steel/18 text-cream ring-1 ring-inset ring-steel/30 hover:bg-steel/28",
        ghost:
          "bg-transparent text-ash hover:bg-cream/6 hover:text-cream",
        outline:
          "bg-transparent text-cream ring-1 ring-inset ring-steel/30 hover:bg-steel/12 hover:ring-steel/45",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-[10px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  asChild = false,
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
