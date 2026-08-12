import Image from "next/image";

interface AppIconProps {
  icon: string;
  darkIcon?: string;
  name: string;
  size?: number;
}

// Every app icon is an SVG in `public/icons/`, and the Next image optimizer
// rejects SVG with a 400 unless `images.dangerouslyAllowSVG` is set — which is
// why these rendered as grey squares. SVG gains nothing from the optimizer, so
// `unoptimized` serves the file straight from `public/`: cacheable, one fewer
// hop, no "dangerously" flag. Keep it on every <Image> added here.
export const AppIcon = ({ icon, darkIcon, name, size = 18 }: AppIconProps) => {
  if (!darkIcon) {
    return (
      <Image src={icon} alt={name} width={size} height={size} unoptimized />
    );
  }

  return (
    <>
      <Image
        src={icon}
        alt={name}
        width={size}
        height={size}
        className="block dark:hidden"
        unoptimized
      />
      <Image
        src={darkIcon}
        alt={name}
        width={size}
        height={size}
        className="hidden dark:block"
        unoptimized
      />
    </>
  );
};
