import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { COMMANDS, SUGGESTIONS } from "@/lib/commands";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onExecute: (command: string) => void;
}

const quickActions = SUGGESTIONS.filter(
  (s) => !s.label.startsWith("/")
);

export default function CommandPalette({
  open,
  onOpenChange,
  onExecute,
}: CommandPaletteProps) {
  const handleSelect = (label: string) => {
    onExecute(label);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 shadow-[0_0_30px_rgba(89,131,146,0.15)]"
      >
        <Command>
          <CommandInput placeholder="Search commands..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>

            <CommandGroup heading="Commands">
              {COMMANDS.map((cmd) => (
                <CommandItem
                  key={cmd.label}
                  value={cmd.label}
                  onSelect={() => handleSelect(cmd.label)}
                >
                  <span className="font-mono text-steel">{cmd.label}</span>
                  <span className="text-ash text-xs">{cmd.desc}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandGroup heading="Quick Actions">
              {quickActions.map((action) => (
                <CommandItem
                  key={action.label}
                  value={action.label}
                  onSelect={() => handleSelect(action.label)}
                >
                  <span className="font-mono text-steel">{action.label}</span>
                  {action.desc && (
                    <span className="text-ash text-xs">{action.desc}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
