"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Field } from "@base-ui/react/field";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

export function ProductUIProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider><Toast.Provider>{children}<Toast.Portal><Toast.Viewport className={styles.toastViewport}><ToastList /></Toast.Viewport></Toast.Portal></Toast.Provider></Tooltip.Provider>;
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => <Toast.Root className={styles.toast} key={toast.id} toast={toast}>
    <Toast.Content className={styles.toastContent}>
      <span className={styles.toastMark} aria-hidden="true">✓</span>
      <span><Toast.Title className={styles.toastTitle} /><Toast.Description className={styles.toastDescription} /></span>
      <Toast.Close className={styles.toastClose} aria-label="Dismiss">×</Toast.Close>
    </Toast.Content>
  </Toast.Root>);
}

export const useProductToast = Toast.useToastManager;

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger className={cx(styles.iconButton, className)} aria-label={label} {...props}>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Positioner className={styles.popupPositioner} sideOffset={8}><Tooltip.Popup className={styles.tooltip}>{label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal></Tooltip.Root>;
}

export function ActionMenu({ label, children, items, className }: {
  label: string;
  children: ReactNode;
  className?: string;
  items: readonly { label: string; description?: string; icon?: string; danger?: boolean; disabled?: boolean; onClick: () => void }[];
}) {
  return <Menu.Root modal={false}>
    <Menu.Trigger className={cx(styles.iconButton, className)} aria-label={label}>{children}</Menu.Trigger>
    <Menu.Portal><Menu.Positioner className={styles.popupPositioner} sideOffset={8} align="end"><Menu.Popup className={styles.menuPopup}>
      {items.map((item) => <Menu.Item className={cx(styles.menuItem, item.danger && styles.danger)} key={item.label} disabled={item.disabled} onClick={item.onClick}>
        {item.icon && <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span>}
        <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
      </Menu.Item>)}
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

export function SelectControl<Value>({ label, value, options, placeholder, disabled, required, name, errorMessage, onValueChange, className, fieldClassName }: {
  label: string;
  value: Value | null | undefined;
  options: readonly { value: Value; label: string; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  errorMessage?: string;
  onValueChange: (value: Value) => void;
  className?: string;
  fieldClassName?: string;
}) {
  return <Field.Root className={cx(styles.field, fieldClassName)} name={name} disabled={disabled}>
    <Field.Label className={styles.fieldLabel}>{label}</Field.Label>
    <Select.Root<Value> value={value ?? null} disabled={disabled} required={required} name={name} items={options} onValueChange={(next) => {
      if (next !== null) onValueChange(next);
    }}>
      <Select.Trigger className={cx(styles.selectTrigger, className)}><Select.Value placeholder={placeholder} /><Select.Icon className={styles.selectIcon}>⌄</Select.Icon></Select.Trigger>
      <Select.Portal><Select.Positioner className={styles.popupPositioner} sideOffset={6} alignItemWithTrigger={false}><Select.Popup className={styles.selectPopup}><Select.List className={styles.selectList}>
        {options.map((option, index) => <Select.Item className={styles.selectItem} key={index} value={option.value} disabled={option.disabled}><Select.ItemIndicator className={styles.selectIndicator}>✓</Select.ItemIndicator><Select.ItemText>{option.label}</Select.ItemText></Select.Item>)}
      </Select.List></Select.Popup></Select.Positioner></Select.Portal>
    </Select.Root>
    {errorMessage && <Field.Error className={styles.fieldError}>{errorMessage}</Field.Error>}
  </Field.Root>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onOpenChange }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Backdrop className={styles.backdrop} /><AlertDialog.Viewport className={styles.dialogViewport}><AlertDialog.Popup className={styles.dialog}>
    <span className={cx(styles.dialogIcon, danger && styles.dialogIconDanger)} aria-hidden="true">{danger ? "!" : "?"}</span>
    <AlertDialog.Title className={styles.dialogTitle}>{title}</AlertDialog.Title>
    <AlertDialog.Description className={styles.dialogDescription}>{description}</AlertDialog.Description>
    <div className={styles.dialogActions}><AlertDialog.Close className={styles.secondaryButton} disabled={busy}>{cancelLabel}</AlertDialog.Close><button className={cx(styles.primaryButton, danger && styles.dangerButton)} disabled={busy} onClick={onConfirm}>{confirmLabel}</button></div>
  </AlertDialog.Popup></AlertDialog.Viewport></AlertDialog.Portal></AlertDialog.Root>;
}
