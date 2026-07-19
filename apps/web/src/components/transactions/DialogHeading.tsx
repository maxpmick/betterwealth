import { Box } from "@mui/material";
import { Typography } from "../mui";

export function DialogHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box>
      <Typography variant="h6">{title}</Typography>
      {subtitle ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {subtitle}
        </Typography>
      ) : null}
    </Box>
  );
}
