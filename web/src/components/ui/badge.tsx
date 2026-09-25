import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "font-mono uppercase tracking-wider text-[10px] px-2 py-0.5 rounded-md border border-transparent inline-flex items-center",
  {
    variants: {
      variant: {
        default: "bg-steel text-ink",
        secondary: "bg-teal text-ash",
        destructive: "bg-steel/80 text-cream animate-subtle-glow",
        outline: "border-steel/40 text-steel bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
