import Image from "next/image";
import { getProviderIcon } from "@onecli/api/apps/provider-icons";

interface ProviderIconProps {
  provider: string;
  size?: number;
}

// Provider icons are SVGs in `public/icons/`, and the Next image optimizer
// rejects SVG with a 400 unless `images.dangerouslyAllowSVG` is set. SVG gains
// nothing from the optimizer, so `unoptimized` serves the file straight from
// `public/`. Keep it on every <Image> here.
export const ProviderIcon = ({ provider, size = 16 }: ProviderIconProps) => {
  const info = getProviderIcon(provider);
  if (!info) return null;
  return (
    <>
      <Image
        src={info.icon}
        alt={info.name}
        width={size}
        height={size}
        unoptimized
        className="dark:hidden"
      />
      <Image
        src={info.darkIcon ?? info.icon}
        alt={info.name}
        width={size}
        height={size}
        unoptimized
        className="hidden dark:block"
      />
    </>
  );
};
