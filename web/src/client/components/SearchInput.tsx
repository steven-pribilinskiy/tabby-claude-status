import { forwardRef, useImperativeHandle, useRef } from "react";

interface SearchInputProps {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	name?: string;
	// Wrapper className — use for layout (flex-1, mb-3, min-w, etc.).
	className?: string;
	// Override the default input classes when a page needs different sizing
	// or background. Default targets card-coloured surfaces with py-1.5.
	inputClassName?: string;
}

const DEFAULT_INPUT_CLASS =
	"w-full pl-3 pr-8 py-1.5 text-sm rounded bg-[var(--card)] border border-[var(--border)] text-[var(--text)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--muted)]";

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
	{ value, onChange, placeholder = "Search...", name = "search", className, inputClassName },
	ref,
) {
	const internalRef = useRef<HTMLInputElement>(null);
	useImperativeHandle(ref, () => internalRef.current as HTMLInputElement, []);

	return (
		<div className={`relative ${className ?? ""}`}>
			<input
				ref={internalRef}
				type="text"
				name={name}
				id={`search-${name}`}
				autoComplete="off"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className={inputClassName ?? DEFAULT_INPUT_CLASS}
			/>
			{value && (
				<button
					type="button"
					onClick={() => {
						onChange("");
						internalRef.current?.focus();
					}}
					aria-label="Clear search"
					title="Clear (Esc)"
					className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--border)] cursor-pointer"
				>
					<span className="text-xs leading-none">✕</span>
				</button>
			)}
		</div>
	);
});
