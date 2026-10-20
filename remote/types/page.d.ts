// Marcas que el código inyectado en la página de la tele (funciones serializadas por CDP) deja en `window`.
// Solo tipos: no se ejecuta nada de aquí.
interface Window {
  __tvFieldBoot?: string;
  __tvFieldSeq?: number;
  __tvPw?: WeakSet<object>;
  __tvFocus?: (s: string) => void;
  __tvFocusLast?: string;
  __tvFocusOn?: number;
  __tvTweak?: number;
}
