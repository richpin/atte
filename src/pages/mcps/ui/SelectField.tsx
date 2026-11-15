import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "shared/ui";

export function SelectField<T extends string>(props: {
  label: string;
  options: T[];
  value: T;
  disabled: boolean;
  labelFor: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <Select<T>
      class="flex min-w-0 flex-col gap-2"
      options={props.options}
      value={props.value}
      disabled={props.disabled}
      optionTextValue={props.labelFor}
      onChange={(value) => value && props.onChange(value)}
      itemComponent={(itemProps) => (
        <SelectItem item={itemProps.item} class="text-sm">
          {props.labelFor(itemProps.item.rawValue)}
        </SelectItem>
      )}
    >
      <SelectLabel class="text-sm font-normal leading-5">
        {props.label}
      </SelectLabel>
      <SelectTrigger class="h-11 min-h-11 text-sm">
        <SelectValue<T>>
          {(state) => props.labelFor(state.selectedOption())}
        </SelectValue>
      </SelectTrigger>
      <SelectContent class="border-line bg-menu text-ink" />
    </Select>
  );
}
