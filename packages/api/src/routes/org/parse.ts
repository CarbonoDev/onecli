import { z } from "zod";
import { ServiceError } from "../../services/errors";

/** Validate-or-throw: an invalid payload is a 422, never a hand-rolled 400. */
export const parse = <S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ServiceError(
      "UNPROCESSABLE",
      result.error.issues[0]?.message ?? "Invalid request body",
    );
  }
  return result.data;
};
