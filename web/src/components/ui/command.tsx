import { Command as CommandPrimitive } from "cmdk";

import { cn } from "@/lib/utils";

function Command({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn(
        "bg-teal border border-steel/30 rounded-xl overflow-hidden shadow-2xl flex h-full w-full flex-col",
        className
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "bg-transparent text-cream placeholder:text-ash/60 border-b border-steel/20 px-4 py-3 w-full text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

function CommandList({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden p-1",
        className
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn("text-ash/60 py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        "overflow-hidden [&_[cmdk-group-heading]]:text-ash/60 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5",
        className
      )}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "px-3 py-2.5 text-sm text-cream cursor-pointer rounded-md mx-1 data-[selected=true]:bg-steel/20 relative flex items-center gap-2 outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <CommandPrimitive.Separator
      ref={ref}
      className={cn("h-px bg-steel/20 -mx-1", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
