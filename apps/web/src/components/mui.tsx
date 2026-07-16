import MuiCheckbox, { type CheckboxProps } from "@mui/material/Checkbox";
import MuiDialog, { type DialogProps } from "@mui/material/Dialog";
import MuiDrawer, { type DrawerProps } from "@mui/material/Drawer";
import MuiListItemText, { type ListItemTextProps } from "@mui/material/ListItemText";
import MuiMenu, { type MenuProps } from "@mui/material/Menu";
import MuiStack, { type StackProps } from "@mui/material/Stack";
import MuiSwitch, { type SwitchProps } from "@mui/material/Switch";
import type { SxProps, Theme } from "@mui/material/styles";
import MuiTextField, { type TextFieldProps } from "@mui/material/TextField";
import MuiTypography, { type TypographyProps } from "@mui/material/Typography";
import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  ElementType,
  FormEventHandler,
  ReactNode,
} from "react";

type ResponsiveValue<T> = T | readonly T[] | { xs?: T; sm?: T; md?: T; lg?: T; xl?: T };

export type CompatStackProps = Omit<StackProps, "onSubmit"> & {
  gap?: ResponsiveValue<number | string>;
  alignItems?: ResponsiveValue<CSSProperties["alignItems"]>;
  justifyContent?: ResponsiveValue<CSSProperties["justifyContent"]>;
  flexWrap?: ResponsiveValue<CSSProperties["flexWrap"]>;
  textAlign?: ResponsiveValue<CSSProperties["textAlign"]>;
  noValidate?: boolean;
  onSubmit?: FormEventHandler<HTMLFormElement>;
};

function sxArray(sx: SxProps<Theme> | undefined): SxProps<Theme>[] {
  if (!sx) return [];
  return Array.isArray(sx) ? (sx as SxProps<Theme>[]) : [sx];
}

export function Stack({
  gap,
  alignItems,
  justifyContent,
  flexWrap,
  textAlign,
  sx,
  ...props
}: CompatStackProps) {
  const Root = MuiStack as ComponentType<Record<string, unknown>>;
  return (
    <Root
      {...props}
      sx={[{ gap, alignItems, justifyContent, flexWrap, textAlign }, ...sxArray(sx)]}
    />
  );
}

export interface CompatTypographyProps extends TypographyProps {
  component?: ElementType;
  fontWeight?: CSSProperties["fontWeight"];
  fontSize?: CSSProperties["fontSize"];
  textAlign?: ResponsiveValue<CSSProperties["textAlign"]>;
  children?: ReactNode;
}

export function Typography({
  fontWeight,
  fontSize,
  textAlign,
  sx,
  ...props
}: CompatTypographyProps) {
  const Root = MuiTypography as ComponentType<Record<string, unknown>>;
  return <Root {...props} sx={[{ fontWeight, fontSize, textAlign }, ...sxArray(sx)]} />;
}

type CompatTextFieldProps = TextFieldProps & {
  InputProps?: Record<string, unknown>;
  inputProps?: ComponentProps<"input">;
};

export function TextField({ InputProps, inputProps, slotProps, ...props }: CompatTextFieldProps) {
  const Root = MuiTextField as ComponentType<Record<string, unknown>>;
  return (
    <Root
      {...props}
      slotProps={{ ...(slotProps as object), input: InputProps, htmlInput: inputProps }}
    />
  );
}

type CompatCheckboxProps = CheckboxProps & { inputProps?: ComponentProps<"input"> };
export function Checkbox({ inputProps, slotProps, ...props }: CompatCheckboxProps) {
  const Root = MuiCheckbox as ComponentType<Record<string, unknown>>;
  return <Root {...props} slotProps={{ ...(slotProps as object), input: inputProps }} />;
}

type CompatSwitchProps = SwitchProps & { inputProps?: ComponentProps<"input"> };
export function Switch({ inputProps, slotProps, ...props }: CompatSwitchProps) {
  const Root = MuiSwitch as ComponentType<Record<string, unknown>>;
  return <Root {...props} slotProps={{ ...(slotProps as object), input: inputProps }} />;
}

type CompatDrawerProps = DrawerProps & { PaperProps?: Record<string, unknown> };
export function Drawer({ PaperProps, slotProps, ...props }: CompatDrawerProps) {
  const Root = MuiDrawer as ComponentType<Record<string, unknown>>;
  return <Root {...props} slotProps={{ ...(slotProps as object), paper: PaperProps }} />;
}

type CompatDialogProps = DialogProps & { PaperProps?: Record<string, unknown> };
export function Dialog({ PaperProps, slotProps, ...props }: CompatDialogProps) {
  const Root = MuiDialog as unknown as ComponentType<Record<string, unknown>>;
  return <Root {...props} slotProps={{ ...(slotProps as object), paper: PaperProps }} />;
}

type CompatMenuProps = MenuProps & { MenuListProps?: Record<string, unknown> };
export function Menu({ MenuListProps, slotProps, ...props }: CompatMenuProps) {
  const Root = MuiMenu as unknown as ComponentType<Record<string, unknown>>;
  return <Root {...props} slotProps={{ ...(slotProps as object), list: MenuListProps }} />;
}

type CompatListItemTextProps = ListItemTextProps & {
  primaryTypographyProps?: CompatTypographyProps;
  secondaryTypographyProps?: CompatTypographyProps;
};
export function ListItemText({
  primaryTypographyProps,
  secondaryTypographyProps,
  slotProps,
  ...props
}: CompatListItemTextProps) {
  const Root = MuiListItemText as ComponentType<Record<string, unknown>>;
  const normalizeTypography = (value: CompatTypographyProps | undefined) => {
    if (!value) return undefined;
    const { fontSize, fontWeight, textAlign, sx, ...rest } = value;
    return { ...rest, sx: [{ fontSize, fontWeight, textAlign }, ...sxArray(sx)] };
  };
  return (
    <Root
      {...props}
      slotProps={{
        ...(slotProps as object),
        primary: normalizeTypography(primaryTypographyProps),
        secondary: normalizeTypography(secondaryTypographyProps),
      }}
    />
  );
}
